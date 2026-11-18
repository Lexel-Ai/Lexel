import type { LintOptions } from 'harper.js';
import {
  closestBox,
  computeLintBoxes,
  getCMRoot,
  getCaretPosition,
  Highlights,
  type IgnorableLintBox,
  isHeading,
  isPointInBox,
  isVisible,
  leafNodes,
  type UnpackedLintGroups,
  type UnpackedSpan,
} from 'lint-framework';
import type { ActivationKey } from '../shared/types';
import { remapLintToCurrentSource } from './lintSpanMapping';

export type LintPopupTrigger = 'hover' | 'click' | 'keyboard';

export interface ActiveLintPopup {
  box: IgnorableLintBox;
  trigger: LintPopupTrigger;
}

export interface LexelLintActions {
  ignoreLint?: (hash: string) => Promise<void>;
  getDelay?: () => Promise<number>;
  onActiveLintChange?: (active: ActiveLintPopup | null) => void;
}

type LintProvider = (
  text: string,
  domain: string,
  options?: LintOptions,
) => Promise<UnpackedLintGroups>;

const INPUT_EVENTS = ['focus', 'keyup', 'keydown', 'paste', 'change', 'scroll', 'input'] as const;
const PAGE_EVENTS = [
  'resize',
  'scroll',
  'keyup',
  'keydown',
  'input',
  'compositionend',
  'selectionchange',
] as const;

const HOVER_OPEN_DELAY_MS = 160;
const HOVER_CLOSE_GRACE_MS = 220;
const MAX_LINT_TEXT_LENGTH = 120000;
const MAX_VISIBLE_PARAGRAPHS = 32;

function isGoogleDocsMirrorTarget(target: Node): target is HTMLElement {
  return (
    target instanceof HTMLElement &&
    target.getAttribute('data-harper-google-docs-target') === 'true'
  );
}

function getGoogleDocsVisibleWindows(target: HTMLElement, source: string): UnpackedSpan[] {
  if (!isGoogleDocsMirrorTarget(target) || target.getAttribute('data-harper-gdocs-source') !== 'native') {
    return [];
  }
  const editor = target.closest('.kix-appview-editor');
  if (!editor) return [];
  const editorRect = editor.getBoundingClientRect();
  const windows: UnpackedSpan[] = [];
  const seen = new Set<number>();
  let traversed = 0;
  let remaining = MAX_LINT_TEXT_LENGTH;

  for (const leaf of leafNodes(target)) {
    const start = traversed;
    traversed += leaf.textContent?.length ?? 0;
    const host = leaf.parentElement?.closest('[data-harper-gdocs-native-start]');
    if (!host || !target.contains(host)) continue;
    const rect = host.getBoundingClientRect();
    if (
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.bottom <= Math.max(0, editorRect.top) ||
      rect.top >= Math.min(window.innerHeight, editorRect.bottom) ||
      rect.right <= Math.max(0, editorRect.left) ||
      rect.left >= Math.min(window.innerWidth, editorRect.right)
    ) {
      continue;
    }

    let cursor = start;
    while (cursor < traversed) {
      const previousBreak = source.lastIndexOf('\n\n', cursor - 1);
      const paragraphStart = previousBreak < 0 ? 0 : previousBreak + 2;
      const nextBreak = source.indexOf('\n\n', cursor);
      const paragraphEnd = nextBreak < 0 ? source.length : nextBreak;
      const length = paragraphEnd - paragraphStart;
      if (!seen.has(paragraphStart)) {
        seen.add(paragraphStart);
        if (length > 0 && length <= remaining) {
          windows.push({ start: paragraphStart, end: paragraphEnd });
          remaining -= length;
          if (windows.length === MAX_VISIBLE_PARAGRAPHS) return windows;
        }
      }
      cursor = paragraphEnd + 2;
    }
  }
  return windows;
}

function getScrollableAncestors(element: Node): Element[] {
  const scrollables: Element[] = [];
  const root = document.scrollingElement || document.documentElement;
  let parent = (element as HTMLElement).parentElement;

  while (parent) {
    const style = window.getComputedStyle(parent);
    if (
      style.overflowY.includes('auto') ||
      style.overflowY.includes('scroll') ||
      style.overflowX.includes('auto') ||
      style.overflowX.includes('scroll')
    ) {
      scrollables.push(parent);
    }
    parent = parent.parentElement;
  }

  if (root && scrollables[scrollables.length - 1] !== root) {
    scrollables.push(root);
  }

  return scrollables;
}

function getTargetLanguage(target: Node): LintOptions['language'] | undefined {
  if (!(target instanceof Element)) return undefined;
  const language = target.getAttribute('data-language');
  if (language === 'plaintext' || language === 'markdown' || language === 'typst') {
    return language;
  }
  return undefined;
}

function boxKey(box: IgnorableLintBox): string {
  return `${box.lint.context_hash}:${box.lint.span.start}:${box.lint.span.end}`;
}

/**
 * Headless lint and highlight orchestrator built on Harper's geometry primitives,
 * driving Lexel's own suggestion popover instead of Harper's built-in UI.
 */
export class LexelLintController {
  private highlights = new Highlights();
  private targets = new Map<Node, { observer?: MutationObserver }>();
  private scrollableAncestors = new Set<HTMLElement>();
  private lintRequest: Promise<unknown> | null = null;
  private pendingLintUpdate = false;
  private renderRequested = false;
  private lintDelayTimer: number | null = null;
  private lastInputAt = 0;
  private lastLints: Array<{
    target: HTMLElement;
    targetIdentity: object;
    lints: UnpackedLintGroups;
  }> = [];
  private lastBoxes: IgnorableLintBox[] = [];
  private attachedSources = new Set<IgnorableLintBox['source']>();

  private openSuggestionsOnHover = true;
  private activationKey: ActivationKey = 'off';
  private lastActivationTap = 0;
  private activePopup: ActiveLintPopup | null = null;
  private popoverHovered = false;
  private pendingHover: { key: string; point: [number, number]; timer: number } | null = null;
  private hoverCloseTimer: number | null = null;
  private pollTimer: number | null = null;

  constructor(
    private readonly lintProvider: LintProvider,
    private readonly actions: LexelLintActions,
  ) {
    for (const event of PAGE_EVENTS) {
      window.addEventListener(event, this.onPageUpdate);
    }
    window.addEventListener('keydown', this.onActivationKeyDown);
    window.addEventListener('blur', this.onWindowBlur);

    // Fallback poll catches editors (like Shadow/iframe rich editors) that mutate without standard events.
    const poll = () => {
      this.update();
      this.pollTimer = window.setTimeout(poll, 1000);
    };
    this.pollTimer = window.setTimeout(poll, 1000);
  }

  public setOpenSuggestionsOnHover(enabled: boolean): void {
    this.openSuggestionsOnHover = enabled;
    if (!enabled) {
      this.cancelPendingHover();
      if (this.activePopup?.trigger === 'hover') {
        this.closePopup();
      }
    }
  }

  public setActivationKey(key: ActivationKey): void {
    this.activationKey = key;
    this.lastActivationTap = 0;
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
      this.actions.onActiveLintChange?.(null);
    }
  }

  public hasTarget(target: Node): boolean {
    return this.targets.has(target);
  }

  public addTarget(target: Node): void {
    if (this.targets.has(target)) return;
    this.targets.set(target, {});
    this.attachTargetListeners(target);
    void this.update();
  }

  public removeTarget(target: HTMLElement): void {
    const registration = this.targets.get(target);
    if (!registration) return;
    this.targets.delete(target);
    for (const event of INPUT_EVENTS) {
      target.removeEventListener(event, this.onPageUpdate);
    }
    registration.observer?.disconnect();
    this.detachSourceListeners(target);
    void this.update();
  }

  public refreshLayout(): void {
    this.requestRender();
  }

  public async update(): Promise<void> {
    this.requestRender();
    await this.requestLintUpdate(false);
  }

  public getLastIgnorableLintBoxes(): IgnorableLintBox[] {
    return this.lastBoxes;
  }

  public destroy(): void {
    if (this.pollTimer != null) {
      clearTimeout(this.pollTimer);
    }
    if (this.lintDelayTimer != null) {
      clearTimeout(this.lintDelayTimer);
    }
    this.cancelPendingHover();
    this.cancelHoverClose();
    for (const event of PAGE_EVENTS) {
      window.removeEventListener(event, this.onPageUpdate);
    }
    window.removeEventListener('keydown', this.onActivationKeyDown);
    window.removeEventListener('blur', this.onWindowBlur);
    for (const source of this.attachedSources) {
      this.detachSourceListeners(source);
    }
  }

  public async requestLintUpdate(immediate = false): Promise<void> {
    const delay = (await this.actions.getDelay?.()) ?? 0;
    const remainingDelay = delay - (Date.now() - this.lastInputAt);

    if (!immediate && delay > 0 && remainingDelay > 0) {
      if (this.lintDelayTimer != null) {
        window.clearTimeout(this.lintDelayTimer);
      }
      this.lintDelayTimer = window.setTimeout(() => {
        this.lintDelayTimer = null;
        void this.requestLintUpdate(false);
      }, remainingDelay);
      return;
    }

    if (this.lintDelayTimer != null) {
      window.clearTimeout(this.lintDelayTimer);
      this.lintDelayTimer = null;
    }

    if (this.lintRequest != null) {
      this.pendingLintUpdate = true;
      if (!immediate) return;
      try {
        await this.lintRequest;
      } catch {
        // Proceed with the explicitly requested refresh after a failed background lint.
      }
      this.pendingLintUpdate = false;
      await this.requestLintUpdate(true);
      return;
    }

    if (this.targets.size === 0) return;

    const request = Promise.all(
      this.onScreenTargets().map(async (target) => {
        if (!document.contains(target)) {
          this.targets.delete(target);
          return { target: null as HTMLElement | null, targetIdentity: {}, lints: {} };
        }

        const targetIdentity = this.targets.get(target)!;
        const { text, isCM, newLineIndices } = this.getTargetText(target);
        if (!text) {
          return { target: null as HTMLElement | null, targetIdentity, lints: {} };
        }

        const language = getTargetLanguage(target);
        try {
          if (text.length > MAX_LINT_TEXT_LENGTH) {
            const windows =
              target instanceof HTMLElement ? getGoogleDocsVisibleWindows(target, text) : [];
            if (windows.length === 0) {
              return { target: null as HTMLElement | null, targetIdentity, lints: {} };
            }
            const lintsBySource: UnpackedLintGroups = {};
            for (const span of windows) {
              const windowText = text.slice(span.start, span.end);
              const groups = window.structuredClone(
                await this.lintProvider(windowText, window.location.hostname, {
                  forceAllHeadings: isHeading(target),
                  language,
                }),
              );
              for (const [rule, lints] of Object.entries(groups)) {
                for (const lint of lints) {
                  lint.span.start += span.start;
                  lint.span.end += span.start;
                  lint.source = text;
                }
                lintsBySource[rule] ??= [];
                lintsBySource[rule].push(...lints);
              }
            }
            return { target: target as HTMLElement, targetIdentity, lints: lintsBySource };
          }

          let lintsBySource = await this.lintProvider(text, window.location.hostname, {
            forceAllHeadings: isHeading(target),
            language,
          });

          if (isCM) {
            lintsBySource = window.structuredClone(lintsBySource);
            for (const lints of Object.values(lintsBySource)) {
              for (const lint of lints) {
                const offsetStart = newLineIndices.findIndex((i) => i > lint.span.start);
                const offsetEnd = newLineIndices.findIndex((i) => i > lint.span.end);
                lint.span.start -= offsetStart;
                lint.span.end -= offsetEnd;
              }
            }
          }

          return { target: target as HTMLElement, targetIdentity, lints: lintsBySource };
        } catch {
          return { target: null as HTMLElement | null, targetIdentity, lints: {} };
        }
      }),
    );

    this.lintRequest = request;
    const lintResults = await request.finally(() => {
      if (this.lintRequest === request) {
        this.lintRequest = null;
      }
    });

    this.lastLints = lintResults.filter(
      (r): r is { target: HTMLElement; targetIdentity: object; lints: UnpackedLintGroups } =>
        r.target != null,
    );
    this.requestRender();

    if (this.pendingLintUpdate) {
      this.pendingLintUpdate = false;
      void this.requestLintUpdate(false);
    }
  }

  private onScreenTargets(): Node[] {
    const visible: Node[] = [];
    for (const target of this.targets.keys()) {
      if (isVisible(target)) {
        visible.push(target);
      }
    }
    return visible;
  }

  private onPageUpdate = (): void => {
    this.lastInputAt = Date.now();
    void this.update();
  };

  private onWindowBlur = (): void => {
    this.cancelPendingHover();
    this.cancelHoverClose();
    if (!this.popoverHovered) {
      this.closePopup();
    }
  };

  private onActivationKeyDown = (event: KeyboardEvent): void => {
    if (this.activationKey === 'off') return;
    if (event.key.toLowerCase() !== this.activationKey) return;
    const now = performance.now();
    const diff = now - this.lastActivationTap;
    this.lastActivationTap = now;
    if (diff > 10 && diff <= 300) {
      this.openClosestToCaret();
    }
  };

  private openClosestToCaret(): void {
    const caret = getCaretPosition();
    if (!caret || this.lastBoxes.length === 0) return;
    const idx = closestBox(caret, this.lastBoxes);
    if (idx < 0) return;
    this.openPopup(this.lastBoxes[idx], 'keyboard');
  }

  private attachTargetListeners(target: Node): void {
    for (const event of INPUT_EVENTS) {
      target.addEventListener(event, this.onPageUpdate);
    }

    const observer = new MutationObserver(this.onPageUpdate);
    this.targets.get(target)!.observer = observer;
    const config = { subtree: true, characterData: true };
    if ((target as HTMLElement).tagName === undefined) {
      observer.observe((target as Node).parentElement!, config);
    } else {
      observer.observe(target as Element, config);
    }

    for (const el of getScrollableAncestors(target)) {
      if (!this.scrollableAncestors.has(el as HTMLElement)) {
        this.scrollableAncestors.add(el as HTMLElement);
        (el as HTMLElement).addEventListener('scroll', this.onPageUpdate, {
          capture: true,
          passive: true,
        });
      }
    }
  }

  private getTargetText(target: Node): {
    text: string | null;
    isCM: boolean;
    newLineIndices: number[];
  } {
    let text: string | null = null;
    const isCM = target instanceof HTMLElement && getCMRoot(target) != null;

    if (isCM) {
      const lineElements = (target as HTMLElement).querySelectorAll<HTMLElement>('.cm-line');
      const lines = Array.from(lineElements).map((el) => el.textContent);
      text = lines.reduce((acc, x) => `${acc}${x ?? ''}\n`, '');
    } else if (isGoogleDocsMirrorTarget(target)) {
      text = target.textContent;
    } else if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      text = target.value;
    } else {
      text = (target as HTMLElement).innerText;
    }

    const newLineIndices: number[] = [];
    let i = 0;
    for (const c of text ?? '') {
      if (c === '\n') newLineIndices.push(i);
      i++;
    }

    return { text, isCM, newLineIndices };
  }

  private requestRender(): void {
    if (this.renderRequested) return;
    this.renderRequested = true;

    requestAnimationFrame(() => {
      try {
        const boxes = this.lastLints.flatMap(({ target, targetIdentity, lints }) => {
          if (!target || this.targets.get(target) !== targetIdentity) {
            return [];
          }
          const mapped = isGoogleDocsMirrorTarget(target);
          const { text, isCM } = this.getTargetText(target);
          if (text == null) return [];

          return Object.entries(lints).flatMap(([ruleName, ls]) =>
            ls.flatMap((lint) => {
              const currentLint =
                isCM || mapped
                  ? lint.source === text
                    ? lint
                    : null
                  : remapLintToCurrentSource(lint, text);
              if (currentLint == null) return [];

              const lintBoxes = computeLintBoxes(target, currentLint, ruleName, {
                ignoreLint: this.actions.ignoreLint
                  ? async (hash: string) => {
                      await this.actions.ignoreLint?.(hash);
                      await this.requestLintUpdate(true);
                    }
                  : undefined,
              });
              for (const box of lintBoxes) {
                const originalApply = box.applySuggestion;
                box.applySuggestion = (suggestion) => {
                  if (this.targets.get(target) === targetIdentity) {
                    return originalApply(suggestion);
                  }
                };
              }
              return lintBoxes;
            }),
          );
        });

        this.lastBoxes = boxes;
        this.highlights.renderLintBoxes(boxes);
        this.syncSourceInteractionListeners(boxes);
        this.reconcileActivePopup(boxes);
      } finally {
        this.renderRequested = false;
      }
    });
  }

  private syncSourceInteractionListeners(boxes: IgnorableLintBox[]): void {
    const nextSources = new Set<IgnorableLintBox['source']>(boxes.map((b) => b.source));
    for (const existing of this.attachedSources) {
      if (!nextSources.has(existing)) {
        this.detachSourceListeners(existing);
      }
    }
    for (const source of nextSources) {
      if (!this.attachedSources.has(source)) {
        source.addEventListener('pointerdown', this.onSourcePointerDown as EventListener);
        source.addEventListener('pointermove', this.onSourcePointerMove as EventListener);
        source.addEventListener('pointerleave', this.onSourcePointerLeave);
        this.attachedSources.add(source);
      }
    }
  }

  private detachSourceListeners(source: IgnorableLintBox['source']): void {
    source.removeEventListener('pointerdown', this.onSourcePointerDown as EventListener);
    source.removeEventListener('pointermove', this.onSourcePointerMove as EventListener);
    source.removeEventListener('pointerleave', this.onSourcePointerLeave);
    this.attachedSources.delete(source);
  }

  private reconcileActivePopup(boxes: IgnorableLintBox[]): void {
    if (!this.activePopup) return;
    const prevKey = boxKey(this.activePopup.box);
    const updated = boxes.find(
      (b) => b.source === this.activePopup!.box.source && boxKey(b) === prevKey,
    );
    if (!updated) {
      this.closePopup();
      return;
    }
    this.activePopup = { ...this.activePopup, box: updated };
    this.actions.onActiveLintChange?.(this.activePopup);
  }

  private openPopup(box: IgnorableLintBox, trigger: LintPopupTrigger): void {
    this.cancelPendingHover();
    this.cancelHoverClose();
    this.activePopup = { box, trigger };
    this.actions.onActiveLintChange?.(this.activePopup);
  }

  private onSourcePointerDown = (event: PointerEvent): void => {
    this.cancelPendingHover();
    const path = event.composedPath();
    const point: [number, number] = [event.x, event.y];
    const hit = this.lastBoxes.find((b) => path.includes(b.source) && isPointInBox(point, b));
    if (hit) {
      this.openPopup(hit, 'click');
      return;
    }
    this.closePopup();
  };

  private onSourcePointerMove = (event: PointerEvent): void => {
    if (!this.openSuggestionsOnHover || event.buttons !== 0 || event.pointerType === 'touch') {
      this.cancelPendingHover();
      return;
    }
    const path = event.composedPath();
    const point: [number, number] = [event.x, event.y];
    const hit = this.lastBoxes.find((b) => path.includes(b.source) && isPointInBox(point, b));

    if (!hit) {
      this.cancelPendingHover();
      if (this.activePopup?.trigger === 'hover' && !this.popoverHovered) {
        this.scheduleHoverClose();
      }
      return;
    }

    this.cancelHoverClose();
    const hitKey = boxKey(hit);
    if (this.activePopup && boxKey(this.activePopup.box) === hitKey) {
      return;
    }
    if (this.pendingHover?.key === hitKey) {
      this.pendingHover.point = point;
      return;
    }

    this.cancelPendingHover();
    const timer = window.setTimeout(() => {
      const targetPoint = this.pendingHover?.point ?? point;
      this.pendingHover = null;
      if (!this.openSuggestionsOnHover) return;
      const fresh = this.lastBoxes.find(
        (b) => boxKey(b) === hitKey && isPointInBox(targetPoint, b),
      );
      if (fresh) {
        this.openPopup(fresh, 'hover');
      }
    }, HOVER_OPEN_DELAY_MS);

    this.pendingHover = { key: hitKey, point, timer };
  };

  private onSourcePointerLeave = (): void => {
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
