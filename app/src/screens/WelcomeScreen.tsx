// First-launch guide (16-Jul): five numbered steps, shown once (App.tsx keeps
// the seen flag in journey-db meta). Deliberately static and dependency-free —
// no carousel, no images — so it can never block someone from reaching the app.
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { colors, spacing } from '../theme';

interface Props {
  onDone: () => void;
}

const STEPS: { title: string; body: string }[] = [
  {
    title: 'Load your journeys',
    body: 'Tap "Refresh from TfL" and sign in to your own TfL account — or import a card statement CSV. Everything stays on your phone.',
  },
  {
    title: 'See what you’re owed',
    body: 'Journeys delayed past TfL’s refund threshold are marked Eligible. Max-fare overcharges from missed tap-outs are flagged too.',
  },
  {
    title: 'Check the evidence',
    body: 'Tap any journey to see expected vs actual time and the line disruption we logged while you were travelling.',
  },
  {
    title: 'Claim on TfL’s own form',
    body: 'The app pre-fills what it can and opens TfL’s claim page. You sign in and submit — refunds go straight back to your card.',
  },
  {
    title: 'Never miss the deadline',
    body: 'You get reminders before each 28-day claim window closes, and missed ones are tracked so you can see what they cost you.',
  },
];

export default function WelcomeScreen({ onDone }: Props) {
  return (
    <View style={styles.container}>
      <ScrollView style={styles.scroll} contentContainerStyle={{ paddingBottom: spacing.l }}>
        <Text style={styles.kicker}>WELCOME</Text>
        <Text style={styles.title}>Get your money back from TfL</Text>
        <Text style={styles.subtitle}>
          Delayed Tube, DLR, Overground or Elizabeth line journey? TfL owes you the fare back.
          Here’s how this works:
        </Text>

        {STEPS.map(({ title, body }, i) => (
          <View key={title} style={styles.step}>
            <View style={styles.stepNumberWrap}>
              <Text style={styles.stepNumber}>{i + 1}</Text>
            </View>
            <View style={styles.stepMain}>
              <Text style={styles.stepTitle}>{title}</Text>
              <Text style={styles.stepBody}>{body}</Text>
            </View>
          </View>
        ))}

        <Text style={styles.footer}>
          Independent app — not affiliated with TfL. No account with us, no server:
          your journey data never leaves this device.
        </Text>
      </ScrollView>

      <Pressable style={styles.button} onPress={onDone}>
        <Text style={styles.buttonText}>Get started</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  kicker: {
    color: colors.accentBright,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
    marginTop: spacing.m,
  },
  title: { color: colors.text, fontSize: 28, fontWeight: '800', marginTop: spacing.xs },
  subtitle: { color: colors.textDim, fontSize: 15, lineHeight: 21, marginTop: spacing.s, marginBottom: spacing.m },
  step: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 12,
    padding: spacing.m,
    marginBottom: spacing.s,
  },
  stepNumberWrap: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.accentBright,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.m,
  },
  stepNumber: { color: '#fff', fontSize: 15, fontWeight: '800' },
  stepMain: { flex: 1 },
  stepTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
  stepBody: { color: colors.textDim, fontSize: 13.5, lineHeight: 19, marginTop: 3 },
  footer: { color: colors.textDim, fontSize: 12.5, lineHeight: 18, marginTop: spacing.s },
  button: {
    backgroundColor: colors.accentBright,
    borderRadius: 14,
    padding: spacing.m,
    alignItems: 'center',
    marginTop: spacing.s,
  },
  buttonText: { color: '#fff', fontSize: 17, fontWeight: '800' },
});
