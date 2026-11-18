import {
  closestBox,
  computeLintBoxes,
  getCaretPosition,
  Highlights,
  type IgnorableLintBox,
  isPointInBox,
  type UnpackedLintGroups,
} from 'lint-framework';
import type { ActivationKey } from './types';
import { remapLintToCurrentSource } from './lintSpanMapping';

export type LintPopupTrigger = 'hover' | 'click' | 'keyboard';

export interface ActiveLabLint {
  box: IgnorableLintBox;
  trigger: LintPopupTrigger;
}

const HOVER_OPEN_DELAY_MS = 160;
const HOVER_CLOSE_GRACE_MS = 220;

function boxKey(box: IgnorableLintBox): string {
  return `${box.lint.context_hash}:${box.lint.span.start}:${box.lint.span.end}`;
}

/**
 * Manages underline geometry and hover/click/keyboard activation for the Lab editor
 * without pulling in Harper's built-in suggestion popup UI.
 */
export class LabLintController {
  private highlights = new Highlights();
  private target: HTMLTextAreaElement | null = null;
  private lastLints: UnpackedLintGroups = {};
  private lastBoxes: IgnorableLintBox[] = [];
  private renderRequested = false;
  private lintDelayTimer: number | null = null;
  private lastInputAt = 0;

  private openSuggestionsOnHover = true;
  private activationKey: ActivationKey = 'off';
  private delayMs = 0;
  private lastActivationTap = 0;
  private activePopup: ActiveLabLint | null = null;
  private popoverHovered = false;
  private pendingHover: { key: string; point: [number, number]; timer: number } | null = null;
  private hoverCloseTimer: number | null = null;
  private lintInFlight = false;
  private pendingRelint = false;

  constructor(
    private readonly lintProvider: (text: string) => Promise<UnpackedLintGroups>,
    private readonly callbacks: {
      ignoreLint: (hash: string) => Promise<void>;
      onActiveLintChange: (active: ActiveLabLint | null) => void;
      onTextMutated: (nextText: string) => void;
    },
  ) {
    window.addEventListener('resize', this.onLayoutChange);
    window.addEventListener('scroll', this.onLayoutChange, true);
    window.addEventListener('keydown', this.onActivationKeyDown);
  }

  public attach(textarea: HTMLTextAreaElement): void {
    if (this.target === textarea) return;
    this.detach();
    this.target = textarea;
    textarea.addEventListener('input', this.onInput);
    textarea.addEventListener('scroll', this.onLayoutChange);
    textarea.addEventListener('keyup', this.onLayoutChange);
    textarea.addEventListener('pointerdown', this.onPointerDown);
    textarea.addEventListener('pointermove', this.onPointerMove);
    textarea.addEventListener('pointerleave', this.onPointerLeave);
    void this.refresh(true);
  }

  public detach(): void {
    if (!this.target) return;
    this.target.removeEventListener('input', this.onInput);
    this.target.removeEventListener('scroll', this.onLayoutChange);
    this.target.removeEventListener('keyup', this.onLayoutChange);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target.removeEventListener('pointerleave', this.onPointerLeave);
    this.target = null;
    this.lastLints = {};
    this.lastBoxes = [];
    this.highlights.renderLintBoxes([]);
  }

  public setOptions(opts: {
    openSuggestionsOnHover: boolean;
    activationKey: ActivationKey;
    delayMs: number;
  }): void {
    this.openSuggestionsOnHover = opts.openSuggestionsOnHover;
    this.activationKey = opts.activationKey;
    this.delayMs = opts.delayMs;
    if (!opts.openSuggestionsOnHover) {
      this.cancelPendingHover();
      if (this.activePopup?.trigger === 'hover') {
        this.closePopup();
      }
    }
  }

  public setPopoverHovered(hovered: boolean): void {
    this.popoverHovered = hovered;
    if (hovered) {
      this.cancelHoverClose();
    } else if (this.activePopup?.trigger === 'hover') {
      this.scheduleHoverClose();
    }
  }

  public closePopup(): void {
    this.cancelPendingHover();
    this.cancelHoverClose();
    if (this.activePopup) {
      this.activePopup = null;
      this.callbacks.onActiveLintChange(null);
    }
  }

  public getBoxes(): IgnorableLintBox[] {
    return this.lastBoxes;
  }

  public async refresh(immediate = false): Promise<void> {
    if (!this.target) return;
    const remainingDelay = this.delayMs - (Date.now() - this.lastInputAt);
    if (!immediate && this.delayMs > 0 && remainingDelay > 0) {
      if (this.lintDelayTimer != null) {
        window.clearTimeout(this.lintDelayTimer);
      }
      this.lintDelayTimer = window.setTimeout(() => {
        this.lintDelayTimer = null;
        void this.refresh(false);
      }, remainingDelay);
      return;
    }

    if (this.lintDelayTimer != null) {
      window.clearTimeout(this.lintDelayTimer);
      this.lintDelayTimer = null;
    }

    if (this.lintInFlight) {
      this.pendingRelint = true;
      return;
    }

    const source = this.target.value;
    this.lintInFlight = true;
    try {
      this.lastLints = source.trim() ? await this.lintProvider(source) : {};
      this.requestRender();
    } finally {
      this.lintInFlight = false;
      if (this.pendingRelint) {
        this.pendingRelint = false;
        void this.refresh(true);
      }
    }
  }

  public destroy(): void {
    this.detach();
    if (this.lintDelayTimer != null) window.clearTimeout(this.lintDelayTimer);
    this.cancelPendingHover();
    this.cancelHoverClose();
    window.removeEventListener('resize', this.onLayoutChange);
    window.removeEventListener('scroll', this.onLayoutChange, true);
    window.removeEventListener('keydown', this.onActivationKeyDown);
  }

  private onInput = (): void => {
    this.lastInputAt = Date.now();
    this.requestRender();
    void this.refresh(false);
  };

  private onLayoutChange = (): void => {
    this.requestRender();
  };

  private onActivationKeyDown = (event: KeyboardEvent): void => {
    if (this.activationKey === 'off') return;
    if (event.key.toLowerCase() !== this.activationKey) return;
    const now = performance.now();
    const diff = now - this.lastActivationTap;
    this.lastActivationTap = now;
    if (diff > 10 && diff <= 300) {
      const caret = getCaretPosition();
      if (!caret || this.lastBoxes.length === 0) return;
      const idx = closestBox(caret, this.lastBoxes);
      if (idx >= 0) {
        this.openPopup(this.lastBoxes[idx], 'keyboard');
      }
    }
  };

  private requestRender(): void {
    if (this.renderRequested || !this.target) return;
    this.renderRequested = true;
    requestAnimationFrame(() => {
      try {
        if (!this.target) return;
        const text = this.target.value;
        const el = this.target;
        const boxes = Object.entries(this.lastLints).flatMap(([ruleName, lints]) =>
          lints.flatMap((lint) => {
            const current = remapLintToCurrentSource(lint, text);
            if (!current) return [];
            const computed = computeLintBoxes(el, current, ruleName, {
              ignoreLint: async (hash: string) => {
                await this.callbacks.ignoreLint(hash);
                await this.refresh(true);
              },
            });
            for (const box of computed) {
              const origApply = box.applySuggestion;
              box.applySuggestion = async (sug) => {
                await origApply(sug);
                this.callbacks.onTextMutated(el.value);
                await this.refresh(true);
              };
            }
            return computed;
          }),
        );
        this.lastBoxes = boxes;
        this.highlights.renderLintBoxes(boxes);
        this.reconcileActivePopup(boxes);
      } finally {
        this.renderRequested = false;
      }
    });
  }

  private reconcileActivePopup(boxes: IgnorableLintBox[]): void {
    if (!this.activePopup) return;
    const key = boxKey(this.activePopup.box);
    const updated = boxes.find((b) => boxKey(b) === key);
    if (!updated) {
      this.closePopup();
      return;
    }
    this.activePopup = { ...this.activePopup, box: updated };
    this.callbacks.onActiveLintChange(this.activePopup);
  }

  private openPopup(box: IgnorableLintBox, trigger: LintPopupTrigger): void {
    this.cancelPendingHover();
    this.cancelHoverClose();
    this.activePopup = { box, trigger };
    this.callbacks.onActiveLintChange(this.activePopup);
  }

  private onPointerDown = (event: PointerEvent): void => {
    this.cancelPendingHover();
    const point: [number, number] = [event.x, event.y];
    const hit = this.lastBoxes.find((b) => isPointInBox(point, b));
    if (hit) {
      this.openPopup(hit, 'click');
      return;
    }
    this.closePopup();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.openSuggestionsOnHover || event.buttons !== 0 || event.pointerType === 'touch') {
      this.cancelPendingHover();
      return;
    }
    const point: [number, number] = [event.x, event.y];
    const hit = this.lastBoxes.find((b) => isPointInBox(point, b));
    if (!hit) {
      this.cancelPendingHover();
      if (this.activePopup?.trigger === 'hover' && !this.popoverHovered) {
        this.scheduleHoverClose();
      }
      return;
    }

    this.cancelHoverClose();
    const hitKey = boxKey(hit);
    if (this.activePopup && boxKey(this.activePopup.box) === hitKey) return;
    if (this.pendingHover?.key === hitKey) {
      this.pendingHover.point = point;
      return;
    }

    this.cancelPendingHover();
    const timer = window.setTimeout(() => {
      const targetPoint = this.pendingHover?.point ?? point;
      this.pendingHover = null;
      if (!this.openSuggestionsOnHover) return;
      const fresh = this.lastBoxes.find((b) => boxKey(b) === hitKey && isPointInBox(targetPoint, b));
      if (fresh) {
        this.openPopup(fresh, 'hover');
      }
    }, HOVER_OPEN_DELAY_MS);
    this.pendingHover = { key: hitKey, point, timer };
  };

  private onPointerLeave = (): void => {
    this.cancelPendingHover();
    if (this.activePopup?.trigger === 'hover' && !this.popoverHovered) {
      this.scheduleHoverClose();
    }
  };

  private cancelPendingHover(): void {
    if (!this.pendingHover) return;
    window.clearTimeout(this.pendingHover.timer);
    this.pendingHover = null;
  }

  private scheduleHoverClose(): void {
    if (this.hoverCloseTimer != null) return;
    this.hoverCloseTimer = window.setTimeout(() => {
      this.hoverCloseTimer = null;
      if (!this.popoverHovered && this.activePopup?.trigger === 'hover') {
        this.closePopup();
      }
    }, HOVER_CLOSE_GRACE_MS);
  }

  private cancelHoverClose(): void {
    if (this.hoverCloseTimer == null) return;
    window.clearTimeout(this.hoverCloseTimer);
    this.hoverCloseTimer = null;
  }
}
