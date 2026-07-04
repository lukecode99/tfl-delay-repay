// Claim prefill (TfL-6). Pure module — node-testable.
//
// The TfL service-delay-refund form lives behind the user's TfL account
// sign-in, so its exact markup isn't stable or inspectable ahead of time.
// Strategy: a keyword-heuristic fill script injected on demand (matches
// inputs by id/name/label/placeholder text and fires proper events), and a
// one-tap copy chip per field as the always-works fallback — per the card.
import type { Assessment } from '../eligibility/engine';
import type { ParsedJourney } from '../journeys/parse';

export interface PrefillField {
  key: string;
  label: string; // chip label in the assist bar
  value: string;
  keywords: string[]; // lowercase haystack keywords for the fill script
}

/** "2026-06-10" → "10/06/2026" (UK format used by TfL forms). */
export const ukDate = (iso: string) => iso.split('-').reverse().join('/');

export function buildPrefill(journey: ParsedJourney, assessment: Assessment | undefined): PrefillField[] {
  const fields: PrefillField[] = [
    { key: 'date', label: 'Date', value: ukDate(journey.date), keywords: ['date'] },
  ];
  if (journey.tapInTime) {
    fields.push({ key: 'timeIn', label: 'Touch in', value: journey.tapInTime, keywords: ['start', 'touch in', 'touched in', 'time in', 'begin'] });
  }
  if (journey.tapOutTime) {
    fields.push({ key: 'timeOut', label: 'Touch out', value: journey.tapOutTime, keywords: ['end', 'touch out', 'touched out', 'time out', 'arriv'] });
  }
  fields.push(
    { key: 'origin', label: 'From', value: journey.origin, keywords: ['from', 'origin', 'start station', 'first station'] },
    { key: 'destination', label: 'To', value: journey.destination ?? '', keywords: ['to station', 'destination', 'end station', 'last station'] },
  );
  if (assessment?.overageMinutes != null) {
    fields.push({
      key: 'delay', label: 'Delay (min)', value: String(assessment.overageMinutes),
      keywords: ['delay', 'duration', 'how long', 'minutes'],
    });
  }
  return fields.filter(f => f.value !== '');
}

/**
 * Injected-JS fill script for react-native-webview's `injectJavaScript`.
 * Fills the first unfilled visible field whose id/name/placeholder/aria-label/
 * <label> text matches a field's keywords, fires input/change events so the
 * page's framework notices, and reports {type:'prefill', filled, total} back
 * through window.ReactNativeWebView.postMessage.
 */
export function buildFillScript(fields: PrefillField[]): string {
  const payload = JSON.stringify(fields.map(({ key, value, keywords }) => ({ key, value, keywords })));
  return `(function () {
  try {
    var fields = ${payload};
    var els = Array.prototype.slice.call(document.querySelectorAll('input, select, textarea'))
      .filter(function (el) {
        if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' || el.type === 'password') return false;
        var r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
    var haystack = function (el) {
      var parts = [el.id, el.name, el.placeholder, el.getAttribute('aria-label')];
      if (el.id) {
        var lab = document.querySelector('label[for="' + el.id + '"]');
        if (lab) parts.push(lab.textContent);
      }
      var wrap = el.closest ? el.closest('label') : null;
      if (wrap) parts.push(wrap.textContent);
      return parts.filter(Boolean).join(' ').toLowerCase();
    };
    var setValue = function (el, value) {
      if (el.tagName === 'SELECT') {
        var opts = Array.prototype.slice.call(el.options);
        var m = opts.find(function (o) { return o.textContent.trim().toLowerCase() === value.toLowerCase(); }) ||
                opts.find(function (o) { return o.textContent.toLowerCase().indexOf(value.toLowerCase()) !== -1; });
        if (!m) return false;
        el.value = m.value;
      } else {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    var used = [];
    var filled = 0;
    fields.forEach(function (f) {
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (used.indexOf(el) !== -1) continue;
        var h = haystack(el);
        if (!h) continue;
        var hit = f.keywords.some(function (k) { return h.indexOf(k) !== -1; });
        if (hit && setValue(el, f.value)) { used.push(el); filled++; break; }
      }
    });
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'prefill', filled: filled, total: fields.length }));
    }
  } catch (e) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'prefill', error: String(e) }));
    }
  }
})(); true;`;
}

/** Entry page for the claim flow — the user signs in and reaches the form from here. */
export const CLAIM_START_URL = 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund';
