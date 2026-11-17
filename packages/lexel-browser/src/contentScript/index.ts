import '@webcomponents/custom-elements';
import { getClosestBlockAncestor, isVisible, leafNodes, LintFramework } from 'lint-framework';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { detectSurfaceFromLocation, isSensitiveElement } from '../shared/surfaceDetector';
import type { DetectedSurfaceContext, SurfaceId } from '../shared/types';
import { AiFloatingPill, type ActiveFieldHandle } from './AiFloatingPill';
import { createGoogleDocsBridgeSync, isGoogleDocsPage } from './googleDocs';
import ProtocolClient from './ProtocolClient';
import tokensCss from 'lexel-ui/tokens.css?inline';

let blocklistCache: string[] = [];
let surfaceOverrideCache: SurfaceId | null = null;
let themeCache: 'dark' | 'light' = 'dark';
let aiEnabledCache = true;
let activeField: ActiveFieldHandle | null = null;
let openSignal = 0;
let pillRoot: Root | null = null;

function currentSurfaceContext(el: Element | null): DetectedSurfaceContext {
  return detectSurfaceFromLocation(window.location.href, {
    blocklist: blocklistCache,
    overrideSurface: surfaceOverrideCache,
    focusedElement: el,
    doc: document,
  });
}

const fw = new LintFramework(
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
    getActivationKey: () => ProtocolClient.getActivationKey(),
    getHotkey: () => ProtocolClient.getHotkey(),
    getDelay: () => ProtocolClient.getDelay(),
    openOptions: () => ProtocolClient.openOptions(),
    addToUserDictionary: (words) => ProtocolClient.addToUserDictionary(words),
    setRuleEnabled: async (ruleId, enabled) => {
      await ProtocolClient.setRuleEnabled(ruleId, enabled);
      fw.update();
    },
  },
);

const syncGoogleDocsBridge = createGoogleDocsBridgeSync(fw);

function ensureShadowMount(): Root {
  if (pillRoot) return pillRoot;
  const host = document.createElement('div');
  host.id = 'lexel-shadow-host';
  host.style.position = 'fixed';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const styleEl = document.createElement('style');
  styleEl.textContent = tokensCss;
  shadow.appendChild(styleEl);

  const container = document.createElement('div');
  shadow.appendChild(container);
  pillRoot = createRoot(container);
  return pillRoot;
}

function renderFloatingPill() {
  const root = ensureShadowMount();
  const ctx = currentSurfaceContext(activeField?.element ?? null);
  root.render(
    React.createElement(AiFloatingPill, {
      field: activeField,
      context: ctx,
      theme: themeCache,
      aiEnabled: aiEnabledCache,
      openSignal,
    }),
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
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
      fw.update();
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

function scanFields() {
  void syncGoogleDocsBridge();
  if (isGoogleDocsPage()) return;

  document.querySelectorAll<HTMLTextAreaElement>('textarea').forEach((el) => {
    if (!el.disabled && !el.readOnly && isVisible(el) && !isSensitiveElement(el)) {
      fw.addTarget(el);
    }
  });

  document.querySelectorAll<HTMLInputElement>('input[type="text"][spellcheck="true"]').forEach((el) => {
    if (!el.disabled && !el.readOnly && !isSensitiveElement(el)) {
      fw.addTarget(el);
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
      fw.addTarget(block);
    }

    if (seenBlocks.size === 0 && isVisible(el)) {
      fw.addTarget(el);
    }
  });
}

async function hydrateConfig() {
  const [blocklist, override, theme, aiSettings, hoverEnabled] = await Promise.all([
    ProtocolClient.getPrivacyBlocklist(),
    ProtocolClient.getSurfaceOverride(window.location.hostname),
    ProtocolClient.getTheme(),
    ProtocolClient.getAiSettings(),
    ProtocolClient.getOpenSuggestionsOnHover(),
  ]);
  blocklistCache = blocklist;
  surfaceOverrideCache = override;
  themeCache = theme;
  aiEnabledCache = aiSettings.enabled;
  fw.setOpenSuggestionsOnHover(hoverEnabled);

  const ctx = currentSurfaceContext(null);
  await ProtocolClient.setPageSummary({
    domain: ctx.domain,
    surfaceId: ctx.surfaceId,
    subcontext: ctx.subcontext,
    harperCount: 0,
    slopCount: 0,
    surfaceWarningCount: 0,
  });
}

document.addEventListener(
  'focusin',
  (event) => {
    if (isEditableElement(event.target)) {
      activeField = makeFieldHandle(event.target);
      fw.addTarget(event.target);
      renderFloatingPill();
    }
  },
  true,
);

document.addEventListener('keydown', (event) => {
  if (event.altKey && event.key.toLowerCase() === 'l' && activeField) {
    event.preventDefault();
    openSignal += 1;
    renderFloatingPill();
  }
});

chrome.storage?.onChanged.addListener((changes) => {
  if (changes.lexel_theme || changes.lexel_ai_settings || changes.lexel_surface_overrides) {
    void hydrateConfig().then(() => {
      ProtocolClient.clearCache();
      fw.update();
      renderFloatingPill();
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

void hydrateConfig().then(() => {
  scanFields();
});

const observer = new MutationObserver(() => scanFields());
if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}
