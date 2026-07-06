// TfL-10: hidden 0×0 WebView that reuses the TfL session (shared system
// cookie store — the user signed in inside the visible claim WebView) to pull
// contactless journey history and funnel it through the normal CSV import.
// Mounted only while a fetch is in flight; the parent unmounts it on result.
import React, { useEffect, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { buildHarvestScript, JOURNEY_HISTORY_URL, pickCardId, rowsToCsv } from './autofetch';
import { listCards } from './db';
import { importCsvText, ImportOutcome } from './import';

export type AutoFetchResult =
  | { kind: 'imported'; outcome: ImportOutcome }
  | { kind: 'empty' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string };

interface Props {
  onResult: (r: AutoFetchResult) => void;
}

const TIMEOUT_MS = 45_000;

export default function AutoFetchWebView({ onResult }: Props) {
  const webRef = useRef<WebView>(null);
  const doneRef = useRef(false);
  const finish = (r: AutoFetchResult) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onResult(r);
  };

  useEffect(() => {
    const t = setTimeout(() => finish({ kind: 'error', message: 'timed out' }), TIMEOUT_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // An expired session redirects to the account sign-in before the harvest
  // script even runs — catch it at the navigation level too.
  const onNavChange = (nav: { url?: string }) => {
    const url = String(nav?.url ?? '').toLowerCase();
    if (/signin|sign-in|login|account\.tfl\.gov\.uk/.test(url)) finish({ kind: 'signed-out' });
  };

  const onMessage = (event: any) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type !== 'journey-harvest') return;
      if (msg.status === 'signed-out') return finish({ kind: 'signed-out' });
      if (msg.status === 'empty') return finish({ kind: 'empty' });
      if (msg.status === 'error') return finish({ kind: 'error', message: String(msg.message ?? 'harvest failed') });
      const csv = msg.status === 'csv' ? String(msg.text ?? '') : rowsToCsv(msg.rows ?? []);
      // Filename → card id: reuse the id previous imports stored so the
      // dedupe index treats auto-fetched rows as the same statement.
      const card = pickCardId(listCards());
      finish({ kind: 'imported', outcome: importCsvText(csv, `${card}.csv`) });
    } catch (e) {
      finish({ kind: 'error', message: String(e) });
    }
  };

  return (
    <View style={styles.hidden} pointerEvents="none">
      <WebView
        ref={webRef}
        source={{ uri: JOURNEY_HISTORY_URL }}
        // Session reuse, not session capture: the cookie stays in the system
        // WebView store — the app never reads or persists credentials.
        sharedCookiesEnabled={true}
        incognito={false}
        onLoadEnd={() => webRef.current?.injectJavaScript(buildHarvestScript())}
        onNavigationStateChange={onNavChange}
        onError={() => finish({ kind: 'error', message: 'page failed to load' })}
        onMessage={onMessage}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  hidden: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' },
});
