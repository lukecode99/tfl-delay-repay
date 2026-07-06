// Claim prefill (TfL-6, reworked TfL-9). Pure module — node-testable.
//
// The TfL service-delay-refund form lives behind the user's TfL account
// sign-in, so its exact markup isn't stable or inspectable ahead of time.
// Strategy: a keyword-heuristic fill script injected on demand (matches
// controls by id/name/label/placeholder text and fires proper events), and a
// one-tap copy chip per field as the always-works fallback — per the card.
//
// TfL-9: Luke's first real claim showed the dropdowns not filling. The
// contactless account site (contactless.tfl.gov.uk) is a jQuery-era ASP.NET
// app; enhanced dropdown widgets (select2/chosen-style) hide the real
// <select>, which the old script's visibility filter excluded entirely, and
// option matching couldn't map values like a raw delay-minute count onto
// option text like "30 to 59 minutes". The fill script now:
//   - keeps hidden <select>s as candidates (the hidden one IS the control),
//   - sets values through the native prototype setters (framework-proof) and
//     fires input/change plus jQuery widget re-render triggers,
//   - matches <option>s by exact text, value, contains, and numeric
//     minute-ranges ("15 to 29 minutes", "more than 1 hour"),
//   - handles date/time split across day/month/year and hour/minute selects,
//   - falls back to radio groups (card selection),
//   - never throws: each field fills inside its own try/catch and the result
//     — including which fields could NOT be filled — is posted back to the
//     app so the assist bar can say exactly what to copy by hand.
import type { Assessment } from '../eligibility/engine';
import type { ParsedJourney } from '../journeys/parse';

export interface PrefillField {
  key: string;
  label: string; // chip label in the assist bar
  value: string;
  keywords: string[]; // lowercase haystack keywords for the fill script
}

/** One entry per field in the fill report posted back to the app. */
export interface FillResult {
  key: string;
  filled: boolean;
  via: string | null; // 'select' | 'input' | 'textarea' | 'radio' | 'time-parts' | 'date-parts'
  note?: string;
}

/** "2026-06-10" → "10/06/2026" (UK format used by TfL forms). */
export const ukDate = (iso: string) => iso.split('-').reverse().join('/');

// Ledger line ids → the display names TfL's own dropdowns use.
const LINE_LABELS: Record<string, string> = {
  bakerloo: 'Bakerloo', central: 'Central', circle: 'Circle', district: 'District',
  'hammersmith-city': 'Hammersmith & City', jubilee: 'Jubilee', metropolitan: 'Metropolitan',
  northern: 'Northern', piccadilly: 'Piccadilly', victoria: 'Victoria',
  'waterloo-city': 'Waterloo & City', dlr: 'DLR', elizabeth: 'Elizabeth line',
  'london-overground': 'London Overground',
  liberty: 'Liberty', lioness: 'Lioness', mildmay: 'Mildmay',
  suffragette: 'Suffragette', weaver: 'Weaver', windrush: 'Windrush',
};
export const lineLabel = (id: string) =>
  LINE_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

// CSV station names sometimes carry a "[London Underground]"-style suffix the
// form's dropdowns don't have.
const cleanStation = (name: string) => name.replace(/\s*\[[^\]]*\]\s*$/, '').trim();

export function buildPrefill(journey: ParsedJourney, assessment: Assessment | undefined): PrefillField[] {
  const fields: PrefillField[] = [
    { key: 'date', label: 'Date', value: ukDate(journey.date), keywords: ['date'] },
  ];
  if (journey.tapInTime) {
    fields.push({ key: 'timeIn', label: 'Touch in', value: journey.tapInTime, keywords: ['touch in', 'touched in', 'time in', 'start time', 'begin'] });
  }
  if (journey.tapOutTime) {
    fields.push({ key: 'timeOut', label: 'Touch out', value: journey.tapOutTime, keywords: ['touch out', 'touched out', 'time out', 'end time', 'arriv'] });
  }
  fields.push(
    { key: 'origin', label: 'From', value: cleanStation(journey.origin), keywords: ['start station', 'first station', 'from station', 'origin', 'from'] },
    { key: 'destination', label: 'To', value: cleanStation(journey.destination ?? ''), keywords: ['end station', 'destination', 'to station', 'last station'] },
  );
  // Line before delay: the line dropdown's haystack ("delayed line") also
  // contains "delay", so the line field must claim it first.
  const lineId = assessment?.disruption?.line ?? assessment?.plausibleLines?.[0];
  if (lineId) {
    fields.push({ key: 'line', label: 'Line', value: lineLabel(lineId), keywords: ['which line', 'line', 'mode of transport', 'service'] });
  }
  if (assessment?.overageMinutes != null) {
    fields.push({
      key: 'delay', label: 'Delay (min)', value: String(assessment.overageMinutes),
      keywords: ['delay', 'duration', 'how long', 'minutes'],
    });
  }
  if (journey.card && journey.card !== 'unknown') {
    fields.push({ key: 'card', label: 'Card', value: journey.card, keywords: ['which card', 'payment card', 'card'] });
  }
  return fields.filter(f => f.value !== '');
}

/**
 * Injected-JS fill script for react-native-webview's `injectJavaScript`.
 * Reports {type:'prefill', filled, total, results:[{key, filled, via}]} back
 * through window.ReactNativeWebView.postMessage; on any top-level failure it
 * reports {type:'prefill', error} instead of throwing into the page.
 *
 * Kept as ES5 source text (not a serialised function): Hermes'
 * Function.prototype.toString returns "[bytecode]", so the injected code must
 * live in a string. The tests run this exact string against a stub DOM.
 */
export function buildFillScript(fields: PrefillField[]): string {
  const payload = JSON.stringify(fields.map(({ key, value, keywords }) => ({ key, value, keywords })));
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var win = window;
    var fields = ${payload};
    var Ev = win.Event;

    var norm = function (s) {
      return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9&:/ ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    var visible = function (el) {
      try { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; } catch (e) { return false; }
    };
    var haystack = function (el) {
      var parts = [el.id, el.name, el.placeholder, el.getAttribute && el.getAttribute('aria-label')];
      try {
        if (el.id) { var lab = doc.querySelector('label[for="' + el.id + '"]'); if (lab) parts.push(lab.textContent); }
        var wrap = el.closest ? el.closest('label') : null; if (wrap) parts.push(wrap.textContent);
        var fs = el.closest ? el.closest('fieldset') : null;
        if (fs && fs.querySelector) { var leg = fs.querySelector('legend'); if (leg) parts.push(leg.textContent); }
      } catch (e) { }
      var joined = '';
      for (var i = 0; i < parts.length; i++) { if (parts[i]) { joined += ' ' + parts[i]; } }
      return norm(joined);
    };
    var setNativeValue = function (el, value) {
      // Go through the prototype setter so framework-managed controls (React
      // et al) see the change; fall back to plain assignment.
      try {
        var proto = null;
        if (el.tagName === 'SELECT' && win.HTMLSelectElement) proto = win.HTMLSelectElement.prototype;
        else if (el.tagName === 'TEXTAREA' && win.HTMLTextAreaElement) proto = win.HTMLTextAreaElement.prototype;
        else if (win.HTMLInputElement) proto = win.HTMLInputElement.prototype;
        var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) { desc.set.call(el, value); return; }
      } catch (e) { }
      el.value = value;
    };
    var fire = function (el) {
      try { el.dispatchEvent(new Ev('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new Ev('change', { bubbles: true })); } catch (e) { }
      // Enhanced widgets (select2/chosen) hide the real <select> and re-render
      // from jQuery-side triggers. Harmless no-ops when absent.
      try {
        if (win.jQuery) { win.jQuery(el).trigger('change').trigger('chosen:updated').trigger('liszt:updated'); }
      } catch (e) { }
    };

    var optionText = function (o) { return norm(o.textContent != null ? o.textContent : o.text); };
    var minutesRange = function (text) {
      // "15 to 29 minutes" → [15,29]; "30 minutes to 1 hour" → [30,60];
      // "more than 1 hour" → [60,Inf]; "up to 15 minutes" → [0,15].
      var nums = [];
      var re = /(\\d+(?:\\.\\d+)?)\\s*(hour|hr|minute|min)?/g;
      var m;
      while ((m = re.exec(text))) {
        var n = parseFloat(m[1]);
        if (m[2] && m[2].charAt(0) === 'h') { n = n * 60; }
        nums.push(n);
      }
      if (!nums.length) return null;
      if (/more than|over|longer|at least|\\+/.test(text)) return [nums[0], Infinity];
      if (/less than|under|up to|within/.test(text)) return [0, nums[0]];
      if (nums.length >= 2) return [nums[0], nums[1]];
      return [nums[0], nums[0]];
    };
    var pickOption = function (el, value) {
      var opts = el.options || (el.querySelectorAll ? el.querySelectorAll('option') : []);
      var list = [];
      for (var i = 0; i < opts.length; i++) list.push(opts[i]);
      var v = norm(value);
      if (!v) return null;
      var find = function (pred) {
        for (var j = 0; j < list.length; j++) { if (pred(list[j])) return list[j]; }
        return null;
      };
      var hit = find(function (o) { return optionText(o) === v; })
        || find(function (o) { return norm(o.value) === v; })
        || find(function (o) { var t = optionText(o); return t && t.indexOf(v) !== -1; })
        || find(function (o) { var t = optionText(o); return t && t.length > 2 && v.indexOf(t) !== -1; });
      if (!hit && /^\\d+$/.test(v)) {
        var n = parseInt(v, 10);
        hit = find(function (o) {
          var r = minutesRange(optionText(o));
          return !!r && n >= r[0] && n <= r[1];
        });
      }
      return hit;
    };
    var setSelect = function (el, value) {
      var m = pickOption(el, value);
      if (!m) return false;
      setNativeValue(el, m.value);
      try { el.selectedIndex = Array.prototype.indexOf.call(el.options, m); } catch (e) { }
      try { m.selected = true; } catch (e) { }
      fire(el);
      return true;
    };

    var fillTimeParts = function (selects, used, startIdx, hh, mm) {
      // The matched select is the hour; the minute select sits shortly after.
      var hourEl = selects[startIdx];
      if (!setSelect(hourEl, hh) && !setSelect(hourEl, String(parseInt(hh, 10)))) return false;
      for (var j = startIdx + 1; j < selects.length && j <= startIdx + 3; j++) {
        var el = selects[j];
        if (used.indexOf(el) !== -1) continue;
        var looksMin = haystack(el).indexOf('min') !== -1 || (el.options && el.options.length >= 45);
        if (!looksMin) continue;
        if (setSelect(el, mm) || setSelect(el, String(parseInt(mm, 10)))) { used.push(el); break; }
      }
      return true;
    };

    var MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    var datePart = function (el) {
      var h = haystack(el);
      if (h.indexOf('month') !== -1) return 'month';
      if (h.indexOf('year') !== -1) return 'year';
      if (h.indexOf('day') !== -1) return 'day';
      var n = el.options ? el.options.length : 0;
      var i;
      for (i = 0; i < n; i++) { if (MONTHS.indexOf(optionText(el.options[i])) !== -1) return 'month'; }
      for (i = 0; i < n; i++) { if (/^(19|20)\\d\\d$/.test(optionText(el.options[i]))) return 'year'; }
      if (n >= 28 && n <= 33) return 'day';
      return null;
    };
    var fillDateParts = function (selects, used, startIdx, dd, mm, yyyy) {
      var wants = {
        day: [dd, String(parseInt(dd, 10))],
        month: [MONTHS[parseInt(mm, 10) - 1], mm, String(parseInt(mm, 10))],
        year: [yyyy],
      };
      var done = 0;
      // The matched select may be any of the three parts; scan a small window
      // around it in DOM order.
      var from = startIdx - 3; if (from < 0) from = 0;
      for (var j = from; j < selects.length && j <= startIdx + 6 && done < 3; j++) {
        var el = selects[j];
        if (used.indexOf(el) !== -1) continue;
        var part = datePart(el);
        if (!part || !wants[part]) continue;
        var cands = wants[part];
        for (var k = 0; k < cands.length; k++) {
          if (cands[k] != null && setSelect(el, cands[k])) { used.push(el); wants[part] = null; done++; break; }
        }
      }
      return done > 0;
    };

    var fillRadio = function (field, radios, used) {
      var v = norm(field.value);
      if (!v) return false;
      for (var i = 0; i < radios.length; i++) {
        var el = radios[i];
        if (used.indexOf(el) !== -1) continue;
        var h = haystack(el);
        var kw = false;
        for (var k = 0; k < field.keywords.length; k++) { if (h.indexOf(field.keywords[k]) !== -1) { kw = true; break; } }
        if (!kw) continue;
        // Within the matched group, pick the radio whose own label carries the value.
        var group = [];
        for (var j = 0; j < radios.length; j++) { if (radios[j].name === el.name) group.push(radios[j]); }
        for (var g = 0; g < group.length; g++) {
          var gh = haystack(group[g]);
          if (gh.indexOf(v) !== -1 || (gh.length > 2 && v.indexOf(gh) !== -1)) {
            try {
              var d = win.HTMLInputElement && Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'checked');
              if (d && d.set) { d.set.call(group[g], true); } else { group[g].checked = true; }
            } catch (e) { group[g].checked = true; }
            fire(group[g]);
            for (var u = 0; u < group.length; u++) used.push(group[u]);
            return true;
          }
        }
        return false; // right group, no value match — don't guess
      }
      return false;
    };

    var all = [];
    try {
      var nodes = doc.querySelectorAll('input, select, textarea');
      for (var n0 = 0; n0 < nodes.length; n0++) all.push(nodes[n0]);
    } catch (e) { }
    var candidates = [];
    var radios = [];
    for (var c = 0; c < all.length; c++) {
      var cel = all[c];
      var ctype = (cel.type || '').toLowerCase();
      if (ctype === 'hidden' || ctype === 'submit' || ctype === 'button' || ctype === 'password' || ctype === 'file' || ctype === 'checkbox' || ctype === 'image') continue;
      if (ctype === 'radio') { radios.push(cel); continue; }
      // Hidden <select>s stay in: enhanced dropdowns hide the real element,
      // and the hidden one is exactly the control that must be set.
      if (cel.tagName !== 'SELECT' && !visible(cel)) continue;
      candidates.push(cel);
    }
    var selects = [];
    for (var s0 = 0; s0 < candidates.length; s0++) { if (candidates[s0].tagName === 'SELECT') selects.push(candidates[s0]); }

    var used = [];
    var results = [];
    var filled = 0;
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var entry = { key: field.key, filled: false, via: null };
      try {
        for (var e2 = 0; e2 < candidates.length; e2++) {
          var el2 = candidates[e2];
          if (used.indexOf(el2) !== -1) continue;
          var h2 = haystack(el2);
          if (!h2) continue;
          var kwHit = false;
          for (var k2 = 0; k2 < field.keywords.length; k2++) { if (h2.indexOf(field.keywords[k2]) !== -1) { kwHit = true; break; } }
          if (!kwHit) continue;
          if (el2.tagName === 'SELECT') {
            if (setSelect(el2, field.value)) {
              used.push(el2); entry.filled = true; entry.via = 'select';
            } else {
              var tm = /^(\\d{1,2}):(\\d{2})$/.exec(field.value);
              var dm = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(field.value);
              if (tm && fillTimeParts(selects, used, selects.indexOf(el2), tm[1], tm[2])) {
                used.push(el2); entry.filled = true; entry.via = 'time-parts';
              } else if (dm && fillDateParts(selects, used, selects.indexOf(el2), dm[1], dm[2], dm[3])) {
                entry.filled = true; entry.via = 'date-parts';
              }
            }
            if (entry.filled) break;
            continue; // this select can't take the value — try the next candidate
          }
          // input / textarea: coerce to the control's expected format
          var v2 = field.value;
          var t2 = (el2.type || '').toLowerCase();
          var dm2 = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(v2);
          if (t2 === 'date' && dm2) { v2 = dm2[3] + '-' + dm2[2] + '-' + dm2[1]; }
          if (t2 === 'number') { var digits = /(\\d+)/.exec(v2); if (digits) v2 = digits[1]; }
          setNativeValue(el2, v2);
          fire(el2);
          used.push(el2); entry.filled = true; entry.via = el2.tagName === 'TEXTAREA' ? 'textarea' : 'input';
          break;
        }
        if (!entry.filled && radios.length && fillRadio(field, radios, used)) {
          entry.filled = true; entry.via = 'radio';
        }
      } catch (err) {
        entry.note = String(err); // graceful no-op for this field, keep going
      }
      if (entry.filled) filled++;
      results.push(entry);
    }
    report({ type: 'prefill', filled: filled, total: fields.length, results: results });
  } catch (e) {
    report({ type: 'prefill', error: String(e) });
  }
})(); true;`;
}

/** Entry page for the claim flow — the user signs in and reaches the form from here. */
export const CLAIM_START_URL = 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund';
