// TfL-37: which binary produced this log line. CI stamps CFBundleVersion with
// the GitHub run number (CURRENT_PROJECT_VERSION in ios.yml), so the native
// build version — not the bundled app.json value, which is permanently "1" —
// is the truth. expo-constants' nativeBuildVersion reads the BUNDLED config
// in this workflow (build 97 logged "build 1"), so expo-application — which
// reads CFBundleVersion from the running binary — is tried first. Note the
// stamp is the CI RUN number series (e.g. 126), not ASC's build number.
// Capture-only: a resolution failure must never break a caller.
import Constants from 'expo-constants';

export const appBuildStamp = (): string => {
  try {
    // Required lazily so a build without the module still boots.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Application = require('expo-application');
    const v = Application?.nativeBuildVersion;
    if (v != null && String(v) !== '' && String(v) !== '1') return String(v);
  } catch { /* fall through */ }
  try {
    const c: any = Constants;
    return String(c?.nativeBuildVersion ?? c?.expoConfig?.ios?.buildNumber ?? '?');
  } catch {
    return '?';
  }
};
