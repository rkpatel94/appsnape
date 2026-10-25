import { useEffect, useState } from 'react';
import {
  Card, CardContent, Typography, Grid, Chip, Box, MenuItem, TextField,
  Dialog, DialogContent, IconButton, Button, Divider,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import RefreshIcon from '@mui/icons-material/Refresh';

/** Browse the screenshots of a completed run, grouped by module. */
export default function Gallery({ runs, activeRun, onPick, onRefresh }) {
  const [manifest, setManifest] = useState(null);
  const [lightbox, setLightbox] = useState(null);
  const [filter, setFilter] = useState('');

  const key = activeRun ? `${activeRun.app}/${activeRun.runId}` : (runs[0] ? `${runs[0].app}/${runs[0].runId}` : '');

  useEffect(() => {
    if (!key) return setManifest(null);
    fetch(`/api/runs/${key}`).then((r) => r.json()).then(setManifest).catch(() => setManifest(null));
  }, [key]);

  if (!runs.length) {
    return (
      <Card variant="outlined">
        <CardContent>
          <Typography color="text.secondary">No runs yet. Start a capture from the first tab.</Typography>
        </CardContent>
      </Card>
    );
  }

  const shotUrl = (app, runId, rel) => `/shots/${app}/${runId}/${rel}`;
  const q = filter.trim().toLowerCase();

  return (
    <>
      <Card variant="outlined" sx={{ mb: 2 }}>
        <CardContent sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <TextField
            select size="small" label="Run" sx={{ minWidth: 340 }} value={key}
            onChange={(e) => {
              const [app, runId] = e.target.value.split('/');
              onPick({ app, runId });
            }}
          >
            {runs.map((r) => (
              <MenuItem key={`${r.app}/${r.runId}`} value={`${r.app}/${r.runId}`}>
                {r.displayName} — {r.runId} ({r.stats.captures} images)
              </MenuItem>
            ))}
          </TextField>

          <TextField
            size="small" label="Filter screens" value={filter}
            onChange={(e) => setFilter(e.target.value)} sx={{ minWidth: 220 }} />

          <Button size="small" startIcon={<RefreshIcon />} onClick={onRefresh}>Refresh</Button>

          {manifest && (
            <Box sx={{ display: 'flex', gap: 1, ml: 'auto', flexWrap: 'wrap' }}>
              <Chip size="small" label={`${manifest.stats.captures} images`} />
              <Chip size="small" label={`${manifest.stats.routes} screens`} />
              <Chip size="small"
                label={`${manifest.app.viewport?.width}×${manifest.app.viewport?.height}`} />
              {manifest.stats.failures > 0
                ? <Chip size="small" color="error" label={`${manifest.stats.failures} failed`} />
                : <Chip size="small" color="success" label="no failures" />}
              <Button size="small" href={`/shots/${key}/PageInventory.md`} target="_blank">PageInventory.md</Button>
              <Button size="small" href={`/shots/${key}/gallery.html`} target="_blank">Static gallery</Button>
            </Box>
          )}
        </CardContent>
      </Card>

      {manifest && manifest.modules.map((mod, mi) => {
        const screens = mod.routes.filter((r) =>
          !q || r.name.toLowerCase().includes(q) || r.path.toLowerCase().includes(q) || mod.name.toLowerCase().includes(q));
        if (!screens.length) return null;
        const count = screens.reduce((n, r) => n + r.captures.reduce((k, c) => k + c.files.length, 0), 0);

        return (
          <Card variant="outlined" key={mod.name} sx={{ mb: 2 }}>
            <CardContent>
              <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                {String(mi + 1).padStart(2, '0')} — {mod.name}
                <Chip size="small" label={count} sx={{ ml: 1 }} />
              </Typography>
              <Divider sx={{ mb: 2 }} />

              {screens.map((r) => (
                <Box key={r.path} sx={{ mb: 2.5 }}>
                  <Typography variant="body2" fontWeight={600}>
                    {r.name}{' '}
                    <Typography component="span" variant="caption" color="text.secondary">{r.path}</Typography>
                  </Typography>
                  {r.status === 'failed' ? (
                    <Typography variant="caption" color="error">Capture failed: {r.error}</Typography>
                  ) : (
                    <Grid container spacing={1.5} sx={{ mt: 0.25 }}>
                      {r.captures.flatMap((c) =>
                        c.files.map((f) => (
                          <Grid item xs={6} sm={4} md={3} lg={2} key={f}>
                            <Box
                              onClick={() => setLightbox(shotUrl(activeRun?.app || runs[0].app, activeRun?.runId || runs[0].runId, f))}
                              sx={{
                                cursor: 'zoom-in', border: '1px solid #e2e8f0', borderRadius: 1.5,
                                overflow: 'hidden', bgcolor: '#fff',
                                '&:hover': { borderColor: 'primary.main' },
                              }}
                            >
                              <img
                                src={shotUrl(activeRun?.app || runs[0].app, activeRun?.runId || runs[0].runId, f)}
                                alt={c.label} loading="lazy"
                                style={{ width: '100%', height: 110, objectFit: 'cover', objectPosition: 'top', display: 'block' }}
                              />
                              <Box sx={{ px: 1, py: 0.75 }}>
                                <Typography variant="caption" sx={{ display: 'block', fontWeight: 600 }} noWrap>
                                  {c.label}
                                </Typography>
                                <Typography variant="caption" color="text.secondary" noWrap>
                                  {f.split('/').pop()}
                                </Typography>
                              </Box>
                            </Box>
                          </Grid>
                        ))
                      )}
                    </Grid>
                  )}
                </Box>
              ))}
            </CardContent>
          </Card>
        );
      })}

      <Dialog open={!!lightbox} onClose={() => setLightbox(null)} maxWidth="xl" fullWidth>
        <DialogContent sx={{ p: 0, position: 'relative', bgcolor: '#0b1120' }}>
          <IconButton
            onClick={() => setLightbox(null)}
            sx={{ position: 'absolute', top: 8, right: 8, color: '#fff', bgcolor: 'rgba(0,0,0,.4)', zIndex: 2 }}
          >
            <CloseIcon />
          </IconButton>
          {lightbox && <img src={lightbox} alt="" style={{ width: '100%', display: 'block' }} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
