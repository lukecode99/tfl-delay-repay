// About & FAQ (TfL terms compliance, 16-Jul): plain-language answers grounded
// in TfL's published service-delay-refund rules, plus the not-affiliated and
// data-stays-on-device statements. Content is static by design — it restates
// TfL's terms and must only change when TfL's terms do.
import React from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import { colors, spacing } from '../theme';

const TFL_REFUND_URL = 'https://tfl.gov.uk/fares/refunds/apply-for-a-service-delay-refund';

interface QA {
  q: string;
  a: string;
}

const FAQ: QA[] = [
  {
    q: 'Which delays can I claim for?',
    a: 'TfL refunds journeys delayed 15 minutes or more on the Tube and DLR, and 30 minutes or more on the London Overground and Elizabeth line. The app applies the right threshold for each journey automatically, based on the fastest route between your stations.',
  },
  {
    q: 'What does TfL exclude?',
    a: 'TfL does not refund delays outside its control — strikes, security alerts, bad weather, planned engineering works and customer incidents — or journeys on buses and trams. Travel on Freedom Pass, 60+ Oyster or Veterans photocards, and children under 11 travelling free, are also excluded.',
  },
  {
    q: 'How long do I have to claim?',
    a: "28 days from the delayed journey. The app counts down each eligible journey's deadline, reminds you before it closes, and marks journeys \"Missed\" once the window has passed — it will never submit or suggest a claim outside the window.",
  },
  {
    q: 'How much do I get back?',
    a: 'A successful claim refunds the single fare for the delayed journey. TfL says claims can take up to 10 working days to review; refunds go back to the contactless card you travelled on, or as Oyster credit / bank transfer.',
  },
  {
    q: 'Who actually submits the claim?',
    a: "You do. The app pre-fills what it can and opens TfL's own claim form in a secure browser view, signed in to your own TfL account. Nothing is ever submitted automatically or on your behalf, and each journey is tracked so you can't accidentally claim for the same one twice.",
  },
  {
    q: 'Why does a journey say "likely eligible"?',
    a: "The app measures your tap-in to tap-out time against TfL's expected journey time. Where our line-status records corroborate a disruption you get higher confidence, but the final decision on every claim is TfL's — \"likely eligible\" is an estimate, not a promise.",
  },
  {
    q: 'Where is my journey data stored?',
    a: 'Entirely on your phone. Journey history, claims and statements live in a local database on the device. There is no app server, no account with us, and your TfL password is never seen or stored by the app — you sign in on TfL\'s own pages.',
  },
  {
    q: 'What about overcharges and incomplete journeys?',
    a: 'Separately from delay refunds, the app spots journeys that look overcharged (for example incomplete fares from a missed tap-out) and points you at the right TfL dispute route. These follow different TfL rules and time limits than delay refunds.',
  },
  {
    q: 'Is this app connected to TfL?',
    a: 'No. This is an independent app and is not affiliated with, endorsed by or connected to Transport for London. TfL journey data is accessed with your permission, through your own TfL account, and all claims are decided by TfL under its own terms.',
  },
];

export default function AboutScreen() {
  return (
    <ScrollView style={styles.container} contentContainerStyle={{ paddingBottom: spacing.l }}>
      <Text style={styles.title}>About</Text>
      <Text style={styles.body}>
        Every year, millions of pounds in TfL delay refunds go unclaimed — not because the delays
        didn't happen, but because nobody has time to notice them, prove them and file before the
        28-day window slams shut.
      </Text>
      <Text style={styles.body}>
        This app does the noticing for you. It measures every Tube, DLR, Overground and Elizabeth
        line journey in your own history against TfL's refund rules, flags the ones worth money —
        including max-fare overcharges from missed tap-outs — and walks you through claiming them
        while there's still time.
      </Text>
      <Text style={styles.body}>
        Independent, private, and on your side: not affiliated with Transport for London, no
        account with us, and your data never leaves your phone. Every claim is submitted by you,
        through TfL's own form.
      </Text>

      <Text style={styles.sectionLabel}>FAQ</Text>
      {FAQ.map(({ q, a }) => (
        <React.Fragment key={q}>
          <Text style={styles.question}>{q}</Text>
          <Text style={styles.answer}>{a}</Text>
        </React.Fragment>
      ))}

      <Pressable onPress={() => Linking.openURL(TFL_REFUND_URL).catch(() => { /* browser declined */ })}>
        <Text style={styles.link}>Read TfL's service delay refund terms ›</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: { color: colors.text, fontSize: 28, fontWeight: '700', marginBottom: spacing.s },
  body: { color: colors.text, fontSize: 15, lineHeight: 21, marginBottom: spacing.s },
  sectionLabel: {
    color: colors.textDim,
    fontSize: 12.5,
    fontWeight: '700',
    letterSpacing: 0.3,
    marginTop: spacing.m,
    marginBottom: spacing.xs,
  },
  question: { color: colors.text, fontSize: 16, fontWeight: '700', marginTop: spacing.m },
  answer: { color: colors.textDim, fontSize: 14.5, lineHeight: 20, marginTop: spacing.xs },
  link: { color: colors.accentBright, fontSize: 15, fontWeight: '600', marginTop: spacing.l },
});
