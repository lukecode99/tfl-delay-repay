// Runs the eligibility engine over stored journeys and caches the verdicts in
// component state. Sequential on purpose: repeated station pairs hit the
// SQLite timing cache, so a statement of N journeys costs far fewer than N
// Journey Planner calls — and the ones it does make are spaced out.
import { useEffect, useRef, useState } from 'react';
import type { Assessment } from './engine';
import { assessParsedJourney, AssessDeps } from './assess';
import { makeSqliteTimingCache } from './adapters';
import { bundledLookup } from './ledger';
import { openJourneyDb, StoredJourney } from '../journeys/db';

let deps: AssessDeps | null = null;
function getDeps(): AssessDeps {
  if (!deps) {
    deps = {
      fetchJson: (url: string) => fetch(url).then(r => r.json()),
      cache: makeSqliteTimingCache(openJourneyDb()),
      lookup: bundledLookup,
    };
  }
  return deps;
}

export type AssessmentMap = Map<number, Assessment>;

export function useAssessments(journeys: StoredJourney[]): AssessmentMap {
  const [results, setResults] = useState<AssessmentMap>(new Map());
  const inFlight = useRef<Set<number>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (const j of journeys) {
        if (cancelled) return;
        if (results.has(j.id) || inFlight.current.has(j.id)) continue;
        inFlight.current.add(j.id);
        try {
          const a = await assessParsedJourney(j, getDeps());
          if (!cancelled) setResults(prev => new Map(prev).set(j.id, a));
        } catch {
          // network hiccup — leave unassessed; retried on next journeys change
          inFlight.current.delete(j.id);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [journeys]);

  return results;
}
