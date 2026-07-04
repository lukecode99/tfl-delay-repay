import React, { useMemo, useState } from 'react';
import {
  FlatList,
  Keyboard,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { searchStations, Station } from '../data';
import { colors, lineColors, spacing } from '../theme';

interface Props {
  placeholder?: string;
  value: Station | null;
  onSelect: (station: Station | null) => void;
}

/** Autocomplete over the bundled station dataset. */
export default function StationSearch({ placeholder = 'Search stations…', value, onSelect }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const results = useMemo(() => searchStations(query), [query]);

  const pick = (s: Station) => {
    onSelect(s);
    setQuery('');
    Keyboard.dismiss();
  };

  if (value) {
    return (
      <TouchableOpacity style={styles.selected} onPress={() => onSelect(null)}>
        <View style={styles.selectedRow}>
          <Text style={styles.selectedName}>{value.name}</Text>
          {value.zone && <Text style={styles.zoneBadge}>Z{value.zone}</Text>}
        </View>
        <View style={styles.lineDots}>
          {value.lines.map(l => (
            <View key={l} style={[styles.dot, { backgroundColor: lineColors[l] ?? colors.textDim }]} />
          ))}
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.wrap}>
      <TextInput
        style={styles.input}
        placeholder={placeholder}
        placeholderTextColor={colors.textDim}
        value={query}
        onChangeText={setQuery}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        autoCorrect={false}
        autoCapitalize="words"
      />
      {focused && results.length > 0 && (
        <FlatList
          style={styles.dropdown}
          data={results}
          keyExtractor={s => s.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => pick(item)}>
              <Text style={styles.rowName}>{item.name}</Text>
              <View style={styles.rowRight}>
                {item.zone && <Text style={styles.zoneBadge}>Z{item.zone}</Text>}
                <View style={styles.lineDots}>
                  {item.lines.slice(0, 6).map(l => (
                    <View key={l} style={[styles.dot, { backgroundColor: lineColors[l] ?? colors.textDim }]} />
                  ))}
                </View>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative', zIndex: 10 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: spacing.m,
    paddingVertical: 12,
  },
  dropdown: {
    backgroundColor: colors.card,
    borderColor: colors.cardBorder,
    borderWidth: 1,
    borderRadius: 10,
    marginTop: spacing.xs,
    maxHeight: 280,
  },
  row: {
    borderBottomColor: colors.cardBorder,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.m,
    paddingVertical: 12,
  },
  rowName: { color: colors.text, fontSize: 15, flexShrink: 1 },
  rowRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.s },
  selected: {
    backgroundColor: colors.card,
    borderColor: colors.accentBright,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: spacing.m,
    paddingVertical: 12,
    gap: spacing.xs,
  },
  selectedRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  selectedName: { color: colors.text, fontSize: 16, fontWeight: '600' },
  zoneBadge: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
  lineDots: { flexDirection: 'row', gap: 3 },
  dot: { width: 8, height: 8, borderRadius: 4 },
});
