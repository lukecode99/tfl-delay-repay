// Avanti West Coast — Delay Repay claim prefill.
//
// Entry point: https://www.avantiwestcoast.co.uk/help/contact-us/delay-repay
// The form is a multi-step Angular-era wizard; we prefill what we can and
// present copy chips for everything else.

import type { PrefillField } from '../claims/prefill.ts';
import { bandLabel } from './eligibility.ts';
import type { RailJourney } from './store-core.ts';
import { stationByCrs } from './stations.ts';

export const AVANTI_CLAIM_URL =
  'https://www.avantiwestcoast.co.uk/help/contact-us/delay-repay';

function stationName(crs: string): string {
  return stationByCrs(crs)?.name ?? crs;
}

/** UK display date: "2026-07-08" → "08/07/2026". */
const ukDate = (iso: string) => iso.split('-').reverse().join('/');

export function buildAvantiPrefill(
  journey: RailJourney,
  delayMinutes: number | null,
): PrefillField[] {
  const fields: PrefillField[] = [
    {
      key: 'date',
      label: 'Date',
      value: ukDate(journey.departureDate),
      keywords: ['date of travel', 'travel date', 'date'],
    },
    {
      key: 'from',
      label: 'From',
      value: stationName(journey.originCrs),
      keywords: ['from station', 'origin', 'departure station', 'from', 'boarding'],
    },
    {
      key: 'to',
      label: 'To',
      value: stationName(journey.destinationCrs),
      keywords: ['to station', 'destination', 'arrival station', 'to', 'alighting'],
    },
    {
      key: 'departTime',
      label: 'Depart',
      value: journey.scheduledDepart,
      keywords: ['departure time', 'depart', 'scheduled', 'planned time'],
    },
  ];

  if (journey.scheduledArrive) {
    fields.push({
      key: 'arriveTime',
      label: 'Arrive (sched)',
      value: journey.scheduledArrive,
      keywords: ['arrival time', 'arrive', 'scheduled arrival'],
    });
  }
  if (journey.actualArrive) {
    fields.push({
      key: 'actualArrive',
      label: 'Actual arrival',
      value: journey.actualArrive,
      keywords: ['actual arrival', 'actual time', 'arrived at'],
    });
  }
  if (delayMinutes != null) {
    fields.push({
      key: 'delay',
      label: 'Delay (min)',
      value: String(delayMinutes),
      keywords: ['delay', 'minutes late', 'how long delayed'],
    });
    fields.push({
      key: 'band',
      label: 'Delay band',
      value: bandLabel(delayMinutes < 15 ? 'none' : delayMinutes < 30 ? 'quarter' : delayMinutes < 60 ? 'half' : delayMinutes < 120 ? 'full-single' : 'full-return'),
      keywords: ['delay band', 'compensation band', 'repay amount'],
    });
  }
  if (journey.singleFare != null) {
    fields.push({
      key: 'fare',
      label: 'Fare (£)',
      value: journey.singleFare.toFixed(2),
      keywords: ['ticket price', 'fare', 'amount paid', 'cost'],
    });
  }

  return fields.filter(f => f.value !== '');
}

/**
 * Inject-friendly ES5 fill script for the Avanti claim form.
 * Same approach as TfL prefill.ts — injected into WebView, reports back via
 * postMessage({type:'prefill', filled, total, results}).
 */
export function buildAvantiFillScript(fields: PrefillField[]): string {
  const payload = JSON.stringify(
    fields.map(({ key, value, keywords }) => ({ key, value, keywords })),
  );
  return `(function () {
  var report = function (msg) {
    if (window.ReactNativeWebView) { window.ReactNativeWebView.postMessage(JSON.stringify(msg)); }
  };
  try {
    var doc = document;
    var fields = ${payload};
    var norm = function (s) {
      return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\\s+/g, ' ').trim();
    };
    var haystack = function (el) {
      var parts = [el.id, el.name, el.placeholder, el.getAttribute && el.getAttribute('aria-label')];
      try {
        if (el.id) { var lab = doc.querySelector('label[for="' + el.id + '"]'); if (lab) parts.push(lab.textContent); }
        var wrap = el.closest ? el.closest('label') : null; if (wrap) parts.push(wrap.textContent);
      } catch (e) { }
      return norm(parts.filter(Boolean).join(' '));
    };
    var setVal = function (el, v) {
      try {
        var p = el.tagName === 'SELECT' ? window.HTMLSelectElement && window.HTMLSelectElement.prototype
          : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement && window.HTMLInputElement.prototype;
        var d = p && Object.getOwnPropertyDescriptor(p, 'value');
        if (d && d.set) { d.set.call(el, v); return; }
      } catch (e) { }
      el.value = v;
    };
    var fire = function (el) {
      try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { }
      try { el.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { }
    };
    var all = [];
    try { var ns = doc.querySelectorAll('input,select,textarea'); for (var i = 0; i < ns.length; i++) all.push(ns[i]); } catch (e) { }
    var results = []; var filled = 0;
    for (var f = 0; f < fields.length; f++) {
      var field = fields[f];
      var entry = { key: field.key, filled: false, via: null };
      try {
        for (var e2 = 0; e2 < all.length; e2++) {
          var el = all[e2];
          var t = (el.type || '').toLowerCase();
          if (t === 'hidden' || t === 'submit' || t === 'button' || t === 'password' || t === 'file') continue;
          var h = haystack(el);
          if (!h) continue;
          var hit = false;
          for (var k = 0; k < field.keywords.length; k++) { if (h.indexOf(field.keywords[k]) !== -1) { hit = true; break; } }
          if (!hit) continue;
          var v = field.value;
          var dm = /^(\\d{2})\\/(\\d{2})\\/(\\d{4})$/.exec(v);
          if (el.type === 'date' && dm) v = dm[3] + '-' + dm[2] + '-' + dm[1];
          setVal(el, v); fire(el);
          entry.filled = true; entry.via = el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'input';
          break;
        }
      } catch (err) { entry.note = String(err); }
      if (entry.filled) filled++;
      results.push(entry);
    }
    report({ type: 'prefill', filled: filled, total: fields.length, results: results });
  } catch (e) {
    report({ type: 'prefill', error: String(e) });
  }
})(); true;`;
}
