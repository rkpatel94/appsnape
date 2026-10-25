import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AppBar, Toolbar, Typography, Container, Grid, Card, CardContent, TextField,
  Button, MenuItem, Switch, FormControlLabel, LinearProgress, Chip, Divider,
  Tabs, Tab, Alert, IconButton, Tooltip, Box, InputAdornment, Autocomplete,
} from '@mui/material';
import PhotoCameraIcon from '@mui/icons-material/PhotoCamera';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import TravelExploreIcon from '@mui/icons-material/TravelExplore';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import LockIcon from '@mui/icons-material/Lock';

import RunLog from './RunLog.jsx';
import Gallery from './Gallery.jsx';

// 'paginate' is available but off by default: a second page of the same table
// rarely teaches the reader anything and doubles the size of a manual.
const RECIPES = ['accordions', 'toggleSweep', 'dropdownSweep', 'tabs', 'filters', 'openAdd', 'rowView', 'rowEdit'];
const ALL_RECIPES = [...RECIPES, 'paginate'];

// Login is not configurable here: every application uses the same JSON login
// endpoint and lands on /dashboard, so it is baked in rather than retyped.
const emptyForm = {
  profile: '',
  name: '',
  displayName: '',
  baseUrl: '',
  username: '',
  password: '',
  viewportWidth: 1440,
  viewportHeight: 900,
  headless: true,
  readOnly: true,
  only: '',
  recipes: RECIPES,
  describe: false,
  manual: false,
  descriptionMode: 'auto',
};

export default function App() {
  const [tab, setTab] = useState(0);
  const [form, setForm] = useState(emptyForm);
  const [profiles, setProfiles] = useState([]);
  const [showPassword, setShowPassword] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, captures: 0, route: null });
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [discovered, setDiscovered] = useState(null);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);
  const [defaults, setDefaults] = useState({ username: null, hasStoredPassword: false });
  const [dropped, setDropped] = useState(null);
  const [stage, setStage] = useState(null);
  const esRef = useRef(null);

  const set = (k) => (e) => {
    const v = e && e.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setForm((f) => ({ ...f, [k]: v }));
  };

  const loadProfiles = () =>
    fetch('/api/profiles').then((r) => r.json()).then((d) => setProfiles(d.profiles || [])).catch(() => {});
  const loadRuns = () =>
    fetch('/api/runs').then((r) => r.json()).then((d) => setRuns(d.runs || [])).catch(() => {});

  const loadDefaults = (app) =>
    fetch(`/api/defaults?app=${encodeURIComponent(app || '')}`)
      .then((r) => r.json())
      .then((d) => {
        setDefaults(d);
        setForm((f) => ({ ...f, username: f.username || d.username || '' }));
      })
      .catch(() => {});

  useEffect(() => { loadProfiles(); loadRuns(); loadDefaults(''); }, []);

  // Live log + progress for whatever run is active.
  useEffect(() => {
    const es = new EventSource('/api/run/events');
    esRef.current = es;
    es.addEventListener('log', (e) => {
      const l = JSON.parse(e.data);
      setLines((prev) => [...prev.slice(-600), l]);
    });
    es.addEventListener('progress', (e) => setProgress(JSON.parse(e.data)));
    es.addEventListener('stage', (e) => setStage(JSON.parse(e.data).stage));
    es.addEventListener('start', () => { setRunning(true); setError(null); setLines([]); setStage(null); });
    es.addEventListener('done', (e) => {
      const r = JSON.parse(e.data);
      setRunning(false);
      const extra = [];
      if (r.descriptions) extra.push(`${r.descriptions.covered}/${r.descriptions.total} descriptions (${r.descriptions.mode === 'ai' ? 'written by Claude' : 'from screen structure'})`);
      if (r.manual) extra.push('operational manual built');
      setNotice(`Captured ${r.stats.captures} screenshots across ${r.stats.routes} screens in ${r.durationSec}s` + (extra.length ? ` — ${extra.join('; ')}.` : '.'));
      loadRuns();
      setActiveRun({ app: r.app, runId: r.runId });
      setTab(2);
    });
    // Profile generation ends with its own event, not 'done'.
    es.addEventListener('profile', () => setRunning(false));
    es.addEventListener('failed', (e) => {
      setRunning(false);
      setError(JSON.parse(e.data).error);
    });
    return () => es.close();
  }, []);

  /**
   * Keep the button state honest. The server is the authority on whether
   * anything is running: if this tab thinks a run is in flight but the server
   * says otherwise (it restarted, the event stream dropped, a run ended while
   * the tab was asleep), clear it rather than leaving the controls disabled.
   */
  useEffect(() => {
    let stop = false;
    const sync = () => {
      fetch('/api/run/status').then((r) => r.json()).then((s) => {
        if (stop) return;
        setRunning((was) => {
          if (was && !s.running) return false;
          if (!was && s.running) { setProgress(s.progress); setLines(s.lines || []); return true; }
          return was;
        });
      }).catch(() => {});
    };
    sync();
    const t = setInterval(sync, 4000);
    return () => { stop = true; clearInterval(t); };
  }, []);

  const selectProfile = (name) => {
    const p = profiles.find((x) => x.name === name);
    setForm((f) => ({
      ...f,
      profile: name,
      name: name || f.name,
      displayName: p ? p.displayName : f.displayName,
      baseUrl: p ? p.baseUrl.replace(/^\$\{.*\}$/, '') || f.baseUrl : f.baseUrl,
      authStrategy: p ? p.authStrategy : f.authStrategy,
    }));
    setDiscovered(null);
    setDropped(null);
    if (name) loadDefaults(name);
  };

  const validate = () => {
    if (!form.profile && !form.baseUrl) return 'Application URL is required.';
    if (!form.profile && !form.name) return 'Give the application a short name (used for the output folder).';
    // A blank password is fine when one is already stored for this app.
    if (!form.username && !defaults.username) return 'Username is required.';
    if (!form.password && !defaults.hasStoredPassword) return 'Password is required.';
    return null;
  };

  const post = async (url, extra) => {
    const body = { ...form, ...(extra || {}) };
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  /**
   * Build a saved profile from the URL and credentials alone: log in, walk the
   * menu, enumerate the reports behind the report selector, probe the standard
   * account/support screens, and drop anything that does not open.
   */
  const onGenerate = async () => {
    const v = validate();
    if (v) return setError(v);
    setError(null); setNotice(null); setDiscovered(null); setDropped(null);
    setRunning(true); setLines([]); setTab(1);
    try {
      const d = await post('/api/profile/generate');
      setDiscovered(d.routes);
      setDropped(d.dropped);
      await loadProfiles();
      await loadDefaults(d.name);
      setForm((f) => ({ ...f, profile: d.name }));
      setNotice(
        `Profile "${d.name}" saved with ${d.routes.length} screens` +
        (d.dropped.length ? `; ${d.dropped.length} screen(s) did not open and were left out.` : '.')
      );
      setTab(0);
    } catch (e) {
      setError(e.message);
      setTab(0);
    } finally {
      setRunning(false);
    }
  };

  const onRun = async () => {
    const v = validate();
    if (v) return setError(v);
    setError(null); setNotice(null); setLines([]);
    try {
      await post('/api/run', discovered && !form.profile ? { routes: discovered } : {});
      setRunning(true);
      setTab(1);
    } catch (e) {
      setError(e.message);
    }
  };

  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const selectedProfile = useMemo(
    () => profiles.find((p) => p.name === form.profile),
    [profiles, form.profile]
  );

  return (
    <>
      <AppBar position="sticky" elevation={0} sx={{ bgcolor: '#0f172a' }}>
        <Toolbar>
          <PhotoCameraIcon sx={{ mr: 1.5 }} />
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 700 }}>AppShot</Typography>
          <Chip
            size="small" icon={<LockIcon />} label="Read-only"
            sx={{ bgcolor: 'rgba(255,255,255,.12)', color: '#fff', mr: 1 }}
          />
          {running && (
            <>
              <Chip size="small" color="warning" label="Running" sx={{ mr: 1 }} />
              <Button
                size="small" variant="outlined"
                sx={{ color: '#fff', borderColor: 'rgba(255,255,255,.4)' }}
                onClick={() => {
                  fetch('/api/run/reset', { method: 'POST' })
                    .then(() => { setRunning(false); setNotice('Run state cleared — you can start a new capture.'); })
                    .catch(() => {});
                }}
              >
                Reset
              </Button>
            </>
          )}
        </Toolbar>
      </AppBar>

      <Container maxWidth="xl" sx={{ py: 3 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
          <Tab label="Capture" />
          <Tab label={`Progress${running ? ' •' : ''}`} />
          <Tab label={`Results (${runs.length})`} />
        </Tabs>

        {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}
        {notice && <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice(null)}>{notice}</Alert>}

        {tab === 0 && (
          <Grid container spacing={2}>
            <Grid item xs={12} md={7}>
              <Card variant="outlined">
                <CardContent>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>Application</Typography>

                  <Autocomplete
                    freeSolo options={profiles.map((p) => p.name)} value={form.profile || null}
                    onChange={(_, v) => selectProfile(v || '')}
                    // Typing an exact profile name should select it too, not
                    // only picking it from the dropdown.
                    onInputChange={(_, v) => {
                      if (profiles.some((p) => p.name === v)) selectProfile(v);
                      else if (!v && form.profile) selectProfile('');
                    }}
                    renderInput={(p) => (
                      <TextField {...p} label="Saved profile (optional)" size="small" margin="dense"
                        helperText="Pick a saved profile to reuse its hand-tuned screen list, or leave blank and let AppShot discover the screens." />
                    )}
                  />

                  <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Application URL" required
                        placeholder="http://your-server"
                        value={form.baseUrl} onChange={set('baseUrl')} />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Short name" required
                        placeholder="lims" value={form.name} onChange={set('name')}
                        helperText="Used for the output folder" />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Username" required autoComplete="off"
                        value={form.username} onChange={set('username')} />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Password" autoComplete="off"
                        type={showPassword ? 'text' : 'password'}
                        placeholder={defaults.hasStoredPassword ? 'using saved password' : ''}
                        helperText={defaults.hasStoredPassword ? 'Leave blank to use the saved one' : ' '}
                        value={form.password} onChange={set('password')}
                        InputProps={{
                          endAdornment: (
                            <InputAdornment position="end">
                              <IconButton size="small" onClick={() => setShowPassword((s) => !s)} edge="end">
                                {showPassword ? <VisibilityOffIcon fontSize="small" /> : <VisibilityIcon fontSize="small" />}
                              </IconButton>
                            </InputAdornment>
                          ),
                        }} />
                    </Grid>
                  </Grid>

                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Credentials are saved locally so you only type them once, and reused as the default for
                    the next application. They stay on this machine and never go into the app profile.
                  </Typography>

                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>Capture</Typography>

                  <Grid container spacing={1.5} alignItems="center">
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" type="number" label="Width"
                        value={form.viewportWidth} onChange={set('viewportWidth')} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField fullWidth size="small" type="number" label="Height"
                        value={form.viewportHeight} onChange={set('viewportHeight')} />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <TextField fullWidth size="small" label="Only these screens (optional)"
                        placeholder="master|report" value={form.only} onChange={set('only')} />
                    </Grid>
                    <Grid item xs={12}>
                      <Autocomplete
                        multiple size="small" options={ALL_RECIPES} value={form.recipes}
                        onChange={(_, v) => setForm((f) => ({ ...f, recipes: v }))}
                        renderTags={(vals, getTagProps) =>
                          vals.map((o, i) => <Chip size="small" label={o} {...getTagProps({ index: i })} key={o} />)}
                        renderInput={(p) => (
                          <TextField {...p} label="Extra states to capture"
                            helperText="Beyond the landing screen: opened sections, every option of a view selector, every trend toggle, tabs, filter panel, Add form, View, Edit" />
                        )}
                      />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <FormControlLabel
                        control={<Switch checked={form.readOnly} onChange={set('readOnly')} />}
                        label="Read-only (never submit or delete)" />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <FormControlLabel
                        control={<Switch checked={!form.headless} onChange={(e) => setForm((f) => ({ ...f, headless: !e.target.checked }))} />}
                        label="Show the browser" />
                    </Grid>
                  </Grid>

                  <Divider sx={{ my: 2 }} />
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                    Afterwards
                  </Typography>

                  <Grid container spacing={1.5} alignItems="center">
                    <Grid item xs={12} sm={6}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={form.describe || form.manual}
                            onChange={(e) => setForm((f) => ({
                              ...f, describe: e.target.checked,
                              manual: e.target.checked ? f.manual : false,
                            }))} />
                        }
                        label="Write descriptions for each screenshot" />
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <FormControlLabel
                        control={
                          <Switch checked={form.manual}
                            onChange={(e) => setForm((f) => ({
                              ...f, manual: e.target.checked,
                              describe: e.target.checked ? true : f.describe,
                            }))} />
                        }
                        label="Build the operational manual" />
                    </Grid>

                    {(form.describe || form.manual) && (
                      <Grid item xs={12}>
                        <TextField
                          select fullWidth size="small" label="How descriptions are written"
                          value={form.descriptionMode} onChange={set('descriptionMode')}
                          helperText={
                            form.descriptionMode === 'basic'
                              ? 'Built from the captured screen structure — columns, fields and buttons. No data leaves this machine.'
                              : defaults.hasApiKey
                                ? 'Claude looks at each screenshot and writes it in plain English. The images are sent to the Anthropic API.'
                                : 'No API key set, so this will fall back to the structural descriptions. Add ANTHROPIC_API_KEY to .env for written ones.'
                          }
                        >
                          <MenuItem value="auto">
                            Best available{defaults.hasApiKey ? ' (Claude reads the screenshots)' : ' (structure only — no API key set)'}
                          </MenuItem>
                          <MenuItem value="ai">Claude reads the screenshots — needs an API key</MenuItem>
                          <MenuItem value="basic">From the captured structure — offline</MenuItem>
                        </TextField>
                      </Grid>
                    )}
                  </Grid>

                  <Box sx={{ display: 'flex', gap: 1.5, mt: 2.5 }}>
                    <Button variant="contained" size="large" startIcon={<PlayArrowIcon />}
                      disabled={running} onClick={onRun}>
                      {running ? 'Running…' : 'Start capture'}
                    </Button>
                    <Tooltip title="For a new application: log in, map every screen and save it as a reusable profile">
                      <span>
                        <Button variant="outlined" size="large" startIcon={<TravelExploreIcon />}
                          disabled={running} onClick={onGenerate}>
                          Set up new application
                        </Button>
                      </span>
                    </Tooltip>
                  </Box>
                </CardContent>
              </Card>
            </Grid>

            <Grid item xs={12} md={5}>
              <Card variant="outlined" sx={{ mb: 2 }}>
                <CardContent>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>
                    {selectedProfile ? 'Profile' : 'Screens'}
                  </Typography>
                  {selectedProfile ? (
                    <>
                      <Typography variant="body2" color="text.secondary">
                        <strong>{selectedProfile.displayName}</strong> — {selectedProfile.routeCount} screens
                        already mapped, including per-screen setup steps and states.
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        The URL and credentials above override the profile for this run.
                      </Typography>
                    </>
                  ) : discovered ? (
                    <Box sx={{ maxHeight: 460, overflow: 'auto' }}>
                      {discovered.map((r) => (
                        <Box key={r.path} sx={{ py: 0.5, borderBottom: '1px solid #eef1f6' }}>
                          <Typography variant="body2" fontWeight={600}>{r.name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {r.module} · <code>{r.path}</code>
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                  ) : (
                    <Typography variant="body2" color="text.secondary">
                      For an application already set up, pick its profile above. For a new one, enter a
                      name, URL and credentials, then press <strong>Set up new application</strong> — it
                      maps every screen and saves a profile you can reuse.
                    </Typography>
                  )}

                  {dropped && dropped.length > 0 && (
                    <Alert severity="warning" sx={{ mt: 2 }}>
                      <Typography variant="body2" fontWeight={600} gutterBottom>
                        Left out — these screens did not open:
                      </Typography>
                      {dropped.map((d) => (
                        <Typography key={d.path} variant="caption" sx={{ display: 'block' }}>
                          {d.name} — <code>{d.path}</code>
                        </Typography>
                      ))}
                    </Alert>
                  )}
                </CardContent>
              </Card>

              <Card variant="outlined">
                <CardContent>
                  <Typography variant="subtitle1" fontWeight={700} gutterBottom>How screens are captured</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Every image is exactly the viewport size you set. A screen taller than the
                    viewport is captured as a series of overlapping slices named
                    <code> _Top</code>, <code>_Middle</code>, <code>_Bottom</code> — never one
                    stretched image, and never a truncated one.
                  </Typography>
                </CardContent>
              </Card>
            </Grid>
          </Grid>
        )}

        {tab === 1 && (
          <Card variant="outlined">
            <CardContent>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1 }}>
                <Typography variant="subtitle1" fontWeight={700}>
                  {running ? (stage === 'describe' ? 'Writing descriptions…' : stage === 'manual' ? 'Building the manual…' : 'Capturing…') : 'Run log'}
                </Typography>
                {progress.total > 0 && (
                  <Typography variant="body2" color="text.secondary">
                    {progress.done} / {progress.total} screens · {progress.captures} images
                    {progress.route ? ` · ${progress.route}` : ''}
                  </Typography>
                )}
              </Box>
              <LinearProgress
                variant={progress.total ? 'determinate' : (running ? 'indeterminate' : 'determinate')}
                value={pct} sx={{ mb: 2, height: 8, borderRadius: 4 }} />
              <RunLog lines={lines} />
            </CardContent>
          </Card>
        )}

        {tab === 2 && (
          <Gallery runs={runs} activeRun={activeRun} onPick={setActiveRun} onRefresh={loadRuns} />
        )}
      </Container>
    </>
  );
}
