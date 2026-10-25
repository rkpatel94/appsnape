import { useEffect, useRef } from 'react';
import { Box } from '@mui/material';

const COLOR = {
  ok: '#16a34a',
  warn: '#b45309',
  error: '#dc2626',
  skip: '#94a3b8',
  banner: '#2563eb',
  group: '#0f766e',
  step: '#64748b',
  info: '#334155',
};

/** Terminal-style live log; auto-follows unless the operator has scrolled up. */
export default function RunLog({ lines }) {
  const boxRef = useRef(null);
  const stickRef = useRef(true);

  useEffect(() => {
    const el = boxRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const onScroll = () => {
    const el = boxRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  return (
    <Box
      ref={boxRef}
      onScroll={onScroll}
      sx={{
        height: 520, overflow: 'auto', bgcolor: '#0b1120', color: '#e2e8f0',
        borderRadius: 2, p: 2, fontFamily: 'ui-monospace, Consolas, monospace',
        fontSize: 12.5, lineHeight: 1.7,
      }}
    >
      {lines.length === 0 && (
        <Box sx={{ color: '#64748b' }}>Waiting for a run to start…</Box>
      )}
      {lines.map((l, i) => (
        <Box
          key={i}
          sx={{
            color: COLOR[l.level] || '#e2e8f0',
            pl: `${(l.indent || 0) * 16}px`,
            fontWeight: l.level === 'banner' || l.level === 'group' ? 700 : 400,
            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
          }}
        >
          {l.level === 'ok' ? '✓ ' : l.level === 'warn' ? '! ' : l.level === 'error' ? '✕ ' : ''}
          {l.message}
        </Box>
      ))}
    </Box>
  );
}
