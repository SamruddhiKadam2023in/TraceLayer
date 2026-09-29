import { useState } from 'react';
import { TextField } from '@/components/TextField';

interface TagsInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  error?: string;
}

function parseTags(text: string): string[] {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Comma-separated tags. Keeps its own text so typing ", " is not normalised away mid-edit. */
export function TagsInput({ value, onChange, error }: TagsInputProps) {
  const [text, setText] = useState(() => value.join(', '));
  return (
    <TextField
      label="Tags"
      placeholder="orders, public"
      hint="Comma-separated. Letters, digits and dashes."
      autoComplete="off"
      value={text}
      error={error}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTags(e.target.value));
      }}
    />
  );
}
