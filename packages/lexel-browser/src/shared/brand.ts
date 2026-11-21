export const LEXEL_LOGO_SRC =
  typeof chrome !== 'undefined' && typeof chrome.runtime?.getURL === 'function'
    ? chrome.runtime.getURL('lexel-logo.svg')
    : '/lexel-logo.svg';
