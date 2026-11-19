import '@webcomponents/custom-elements';
import { getClosestBlockAncestor, isVisible, leafNodes } from 'lint-framework';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import appCss from '../app.css?inline';
import { detectSurfaceFromLocation, isSensitiveElement } from '../shared/surfaceDetector';
import type {
  AiTaskId,
  DetectedSurfaceContext,
  Hotkey,
  SurfaceId,
  SurfaceProfile,
} from '../shared/types';
import { AiFloatingPill, type ActiveFieldHandle } from './AiFloatingPill';
import { createGoogleDocsBridgeSync, isGoogleDocsPage } from './googleDocs';
import { type ActiveLintPopup, LexelLintController } from './LexelLintController';
import { LexelSuggestionPopover } from './LexelSuggestionPopover';
import ProtocolClient from './ProtocolClient';
import tokensCss from 'lexel-ui/tokens.css?inline';

let blocklistCache: string[] = [];
let surfaceOverrideCache: SurfaceId | null = null;
let customSurfacesCache: SurfaceProfile[] = [];
let themeCache: 'dark' | 'light' = 'dark';
let aiEnabledCache = true;
let hotkeyCache: Hotkey = { modifiers: ['Alt'], key: 'l' };
let activeField: ActiveFieldHandle | null = null;
let activeLintPopup: ActiveLintPopup | null = null;
let openSignal = 0;
let requestedTask: { id: AiTaskId; seq: number } | null = null;
let taskSeq = 0;
let shadowHost: HTMLElement | null = null;
let overlayRoot: Root | null = null;

function currentSurfaceContext(el: Element | null): DetectedSurfaceContext {
  return detectSurfaceFromLocation(window.location.href, {
    blocklist: blocklistCache,
    overrideSurface: surfaceOverrideCache,
    focusedElement: el,
    doc: document,
    customSurfaces: customSurfacesCache,
  });
}

const lintController = new LexelLintController(
  (text, domain, options) => {
    const ctx = currentSurfaceContext(activeField?.element ?? null);
    if (ctx.isBlocked) {
      return Promise.resolve({});
    }
    return ProtocolClient.lint(text, domain, options, {
      surfaceId: ctx.surfaceId,
      subcontext: ctx.subcontext,
    });
  },
  {
    ignoreLint: (hash) => ProtocolClient.ignoreHash(hash),
    getDelay: () => ProtocolClient.getDelay(),
    onActiveLintChange: (next) => {
      activeLintPopup = next;
      renderOverlays();
    },
  },
);

const syncGoogleDocsBridge = createGoogleDocsBridgeSync(lintController);

function ensureShadowMount(): Root {
  if (overlayRoot) return overlayRoot;
  const host = document.createElement('div');
  host.id = 'lexel-shadow-host';
  host.style.position = 'fixed';
  host.style.inset = '0';
  host.style.zIndex = '2147483647';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);
  shadowHost = host;

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = `${appCss}\n${tokensCss}`;
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  shadow.appendChild(container);
  overlayRoot = createRoot(container);
  return overlayRoot;
}

function renderOverlays() {
  const root = ensureShadowMount();
  const ctx = currentSurfaceContext(activeField?.element ?? null);
  root.render(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(AiFloatingPill, {
        field: activeField,
        context: ctx,
        theme: themeCache,
        aiEnabled: aiEnabledCache,
        openSignal,
        requestedTask,
        customSurfaces: customSurfacesCache,
      }),
      React.createElement(LexelSuggestionPopover, {
        active: activeLintPopup,
        theme: themeCache,
        aiEnabled: aiEnabledCache,
        onHoverChange: (hovered) => lintController.setPopoverHovered(hovered),
        onClose: () => lintController.closePopup(),
        onApplied: () => {
          void lintController.requestLintUpdate(true);
        },
        onAddToDictionary: async (word) => {
          await ProtocolClient.addToUserDictionary([word]);
          await lintController.requestLintUpdate(true);
        },
        onDisableRule: async (ruleId) => {
          await ProtocolClient.setRuleEnabled(ruleId, false);
          await lintController.requestLintUpdate(true);
        },
        onAllowSlopTerm: async (term) => {
          await ProtocolClient.allowSlopTerm(term);
          await lintController.requestLintUpdate(true);
        },
        onOpenSettings: () => ProtocolClient.openOptions(),
        onFixWithAi: (box) => {
          const rootEl = resolveEditableRoot(box.source) ?? activeField?.element;
          if (rootEl) {
            activeField = makeFieldHandle(rootEl);
          }
          taskSeq += 1;
          requestedTask = {
            id: box.rule === 'LexelAntiSlop' ? 'deslop' : 'fix_grammar_flow',
            seq: taskSeq,
          };
          openSignal += 1;
          renderOverlays();
        },
      }),
    ),
  );
}

function readThreadContextAround(el: HTMLElement): string {
  const heading = document.querySelector('h1')?.textContent?.trim() ?? '';
  const parentComment =
    el.closest('[data-testid="comment"], .Comment, .comment, article')?.textContent?.trim() ?? '';
  const combined = [heading ? `Post title: ${heading}` : '', parentComment]
    .filter(Boolean)
    .join('\n\n');
  return combined.slice(0, 1200);
}

function setElementValueSafely(el: HTMLElement, nextText: string) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, nextText);
    } else {
      el.value = nextText;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return;
  }

  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand('insertText', false, nextText);
    if (!inserted) {
      el.innerText = nextText;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: nextText }));
    }
  }
}

function makeFieldHandle(el: HTMLElement): ActiveFieldHandle {
  return {
    element: el,
    readText: () => {
      if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
        return el.value;
      }
      return el.innerText;
    },
    writeText: (nextText: string) => {
      setElementValueSafely(el, nextText);
      void lintController.update();
    },
    readThreadContext: () => readThreadContextAround(el),
  };
}

function isEditableElement(node: EventTarget | null): node is HTMLElement {
  if (!(node instanceof HTMLElement)) return false;
  if (isSensitiveElement(node)) return false;
  if (node instanceof HTMLTextAreaElement) return !node.disabled && !node.readOnly;
  if (node instanceof HTMLInputElement) {
    return node.type === 'text' && !node.disabled && !node.readOnly;
  }
  return node.isContentEditable;
}

/** Resolve inner <p>/<span> nodes of a rich editor up to its contenteditable root. */
function resolveEditableRoot(node: EventTarget | null): HTMLElement | null {
  if (!isEditableElement(node)) return null;
  if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
    return node;
  }
  let current: HTMLElement = node;
  while (current.parentElement && current.parentElement.isContentEditable) {
    current = current.parentElement;
  }
  return isSensitiveElement(current) ? null : current;
}

function scanFields() {
  void syncGoogleDocsBridge();
  if (isGoogleDocsPage()) return;

  document.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((el) => {
    if (!el.disabled && !el.readOnly && isVisible(el) && !isSensitiveElement(el)) {
      lintController.addTarget(el);
    }
  });

  document.querySelectorAll<HTMLInputElement>('input[type="text"][spellcheck="true"]').forEach((el) => {
    if (!el.disabled && !el.readOnly && !isSensitiveElement(el)) {
      lintController.addTarget(el);
    }
  });

  document.querySelectorAll('[contenteditable="true"], [contenteditable=""]').forEach((el) => {
    if (!(el instanceof HTMLElement) || isSensitiveElement(el)) return;
    if (el.matches('[role="combobox"]')) return;
    const isLexical = el.getAttribute('data-lexical-editor') === 'true';
    const isQuill = el.classList.contains('ql-editor');
    const isWebmail =
      window.location.hostname === 'mail.google.com' ||
      window.location.hostname === 'outlook.live.com';
    if (el.getAttribute('spellcheck') === 'false' && !isLexical && !isQuill && !isWebmail) {
      return;
    }

    const seenBlocks = new Set<Element>();
    for (const leaf of leafNodes(el)) {
      if (leaf.parentElement?.closest('[contenteditable="false"],[disabled],[readonly]') != null) {
        continue;
      }
      const block = getClosestBlockAncestor(leaf, el);
      if (!block || seenBlocks.has(block) || !isVisible(block)) {
        continue;
      }
      seenBlocks.add(block);
      lintController.addTarget(block);
    }

    if (seenBlocks.size === 0 && isVisible(el)) {
      lintController.addTarget(el);
    }
  });
}

async function hydrateConfig(initializeSummary = false) {
  try {
    const [
      blocklist,
      override,
      customSurfaces,
      theme,
      aiSettings,
      hoverEnabled,
      activationKey,
      hotkey,
    ] = await Promise.all([
      ProtocolClient.getPrivacyBlocklist().catch(() => []),
      ProtocolClient.getSurfaceOverride(window.location.hostname).catch(() => null),
      ProtocolClient.getCustomSurfaces().catch(() => []),
      ProtocolClient.getTheme().catch(() => 'dark' as const),
      ProtocolClient.getAiSettings().catch(() => ({ enabled: true })),
      ProtocolClient.getOpenSuggestionsOnHover().catch(() => true),
      ProtocolClient.getActivationKey().catch(() => 'off' as const),
      ProtocolClient.getHotkey().catch(() => ({ modifiers: ['Alt'], key: 'l' }) as Hotkey),
    ]);
    blocklistCache = blocklist;
    surfaceOverrideCache = override;
    customSurfacesCache = customSurfaces;
    themeCache = theme;
    aiEnabledCache = aiSettings.enabled;
    hotkeyCache = hotkey;
    lintController.setOpenSuggestionsOnHover(hoverEnabled);
    lintController.setActivationKey(activationKey);

    if (initializeSummary) {
      const ctx = currentSurfaceContext(activeField?.element ?? null);
      await ProtocolClient.setPageSummary({
        domain: ctx.domain,
        surfaceId: ctx.surfaceId,
        subcontext: ctx.subcontext,
        harperCount: 0,
        slopCount: 0,
        surfaceWarningCount: 0,
      }).catch(() => undefined);
    }
  } catch {
    // Keep defaults if background service worker is still waking up.
  }
}

function captureFocusedElement(target: EventTarget | null) {
  const rootEl = resolveEditableRoot(target);
  if (!rootEl) return;
  activeField = makeFieldHandle(rootEl);
  if (rootEl instanceof HTMLTextAreaElement || rootEl instanceof HTMLInputElement) {
    lintController.addTarget(rootEl);
  } else {
    scanFields();
    if (!lintController.hasTarget(rootEl) && target instanceof HTMLElement) {
      const hasRegisteredChild = Array.from(rootEl.querySelectorAll('*')).some((el) =>
        lintController.hasTarget(el),
      );
      if (!hasRegisteredChild) {
        lintController.addTarget(rootEl);
      }
    }
  }
  renderOverlays();
}

document.addEventListener(
  'focusin',
  (event) => {
    captureFocusedElement(event.target);
  },
  true,
);

document.addEventListener(
  'pointerdown',
  (event) => {
    if (!activeLintPopup) return;
    const path = event.composedPath();
    if (shadowHost && path.includes(shadowHost)) return;
    if (path.includes(activeLintPopup.box.source)) return;
    lintController.closePopup();
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (!activeField) return;
  const needCtrl = hotkeyCache.modifiers.includes('Ctrl');
  const needShift = hotkeyCache.modifiers.includes('Shift');
  const needAlt = hotkeyCache.modifiers.includes('Alt');
  if (
    event.ctrlKey === needCtrl &&
    event.shiftKey === needShift &&
    event.altKey === needAlt &&
    event.key.toLowerCase() === hotkeyCache.key.toLowerCase()
  ) {
    event.preventDefault();
    openSignal += 1;
    renderOverlays();
  }
});

const WATCHED_STORAGE_KEYS = new Set([
  'lexel_theme',
  'lexel_ai_settings',
  'lexel_surface_overrides',
  'lexel_privacy_blocklist',
  'lexel_custom_slop_terms',
  'lexel_disabled_slop_terms',
  'lexel_custom_surfaces',
  'lexel_language_mode',
  'openSuggestionsOnHover',
  'activationKey',
  'hotkey',
  'defaultEnable',
  'delay',
  'userDictionary',
  'dialect',
  'isolateEnglish',
  'lintConfig',
  'ignoredLints',
]);

chrome.storage?.onChanged.addListener((changes) => {
  if (
    Object.keys(changes).some(
      (k) => WATCHED_STORAGE_KEYS.has(k) || k.startsWith('domainStatus '),
    )
  ) {
    void hydrateConfig().then(() => {
      ProtocolClient.clearCache();
      void lintController.update();
      renderOverlays();
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === 'getFocusedDraft') {
    const ctx = currentSurfaceContext(activeField?.element ?? null);
    sendResponse({
      text: activeField?.readText() ?? '',
      surfaceId: ctx.surfaceId,
      subcontext: ctx.subcontext,
    });
  } else if (msg?.kind === 'applyDraftToFocused' && typeof msg.text === 'string' && activeField) {
    activeField.writeText(msg.text);
    sendResponse({ ok: true });
  }
});

void hydrateConfig(true).finally(() => {
  scanFields();
  if (document.activeElement) {
    captureFocusedElement(document.activeElement);
  }
});

const observer = new MutationObserver(() => scanFields());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
