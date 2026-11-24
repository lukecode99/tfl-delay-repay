// TfL-37: which binary produced this log line. CI stamps CFBundleVersion with
// the GitHub run number (CURRENT_PROJECT_VERSION in ios.yml), so the native
// build version — not the bundled app.json value, which is permanently "1" —
// is the truth. Capture-only: a resolution failure must never break a caller.
import Constants from 'expo-constants';

export const appBuildStamp = (): string => {
  try {
    const c: any = Constants;
    return String(c?.nativeBuildVersion ?? c?.expoConfig?.ios?.buildNumber ?? '?');
  } catch {
    return '?';
  }
};
