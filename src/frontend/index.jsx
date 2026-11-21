/**
 * Ship Context - release readiness dashboard (Jira global page, UI Kit 2).
 *
 * Flow: pick a project -> pick a fix version -> the resolver returns the
 * release analysis (score, status breakdown, risk list, suggested actions)
 * which is rendered as a scorecard judges can drill into.
 */
import React, { useEffect, useState } from 'react';
import ForgeReconciler, {
  Badge, Box, Button, DynamicTable, EmptyState, Heading, Inline,
  Lozenge, ProgressBar, SectionMessage, Select,
  Spinner, Stack, Text,
} from '@forge/react';
import { invoke } from '@forge/bridge';

const GRADE_APPEARANCE = {
  'On track': 'success',
  'Minor concerns': 'inprogress',
  'At risk': 'warning',
  'Off track': 'removed',
  'No scope': 'default',
};

function RiskRow({ r }) {
  return {
    key: r.key,
    cells: [
      { content: r.key },
      { content: r.summary },
      { content: r.status },
      { content: r.assignee },
      { content: r.reasons.join('; ') },
    ],
  };
}

function App() {
  const [projects, setProjects] = useState(null);
  const [versions, setVersions] = useState(null);
  const [project, setProject] = useState(null);
  const [version, setVersion] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    invoke('getProjects').then(setProjects).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!project) return;
    setVersions(null); setVersion(null); setAnalysis(null);
    invoke('getVersions', { projectKey: project }).then(setVersions).catch((e) => setError(String(e)));
  }, [project]);

  const analyse = () => {
    setLoading(true); setError(null); setAnalysis(null);
    invoke('getAnalysis', { projectKey: project, versionName: version })
      .then((a) => { if (a.error) setError(a.error); else setAnalysis(a); })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  };

  if (error && !projects) {
    return <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>;
  }
  if (!projects) {
    return <Inline alignBlock="center"><Spinner size="large" /></Inline>;
  }

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Heading size="large">Ship Context</Heading>
        <Lozenge appearance="inprogress">Release readiness</Lozenge>
      </Inline>
      <Text>Pick a project and a fix version to see whether it is ready to ship - score, blockers, stale work and next actions in one view.</Text>

      <Inline space="space.200" alignBlock="end">
        <Box>
          <Select
            label="Project"
            placeholder="Choose project"
            options={projects.map((p) => ({ label: `${p.name} (${p.key})`, value: p.key }))}
            onChange={(o) => setProject(o && o.value)}
          />
        </Box>
        <Box>
          <Select
            label="Fix version"
            placeholder={versions ? (versions.length ? 'Choose version' : 'No versions') : 'Pick project first'}
            isDisabled={!versions || !versions.length}
            options={(versions || []).filter((v) => !v.released).map((v) => ({ label: v.name, value: v.name }))}
            onChange={(o) => setVersion(o && o.value)}
          />
        </Box>
        <Button appearance="primary" isDisabled={!project || !version || loading} onClick={analyse}>
          {loading ? 'Analysing...' : 'Analyse release'}
        </Button>
      </Inline>

      {error && <SectionMessage appearance="error"><Text>{error}</Text></SectionMessage>}
      {loading && <Inline alignBlock="center"><Spinner size="large" /></Inline>}

      {analysis && (
        <Stack space="space.200">
          <Inline space="space.400" alignBlock="center">
            <Stack space="space.050">
              <Inline space="space.100" alignBlock="center">
                <Heading size="xlarge">{analysis.score}</Heading>
                <Lozenge appearance={GRADE_APPEARANCE[analysis.grade] || 'default'}>{analysis.grade}</Lozenge>
              </Inline>
              <Text>Readiness score for {analysis.projectKey} {analysis.version}{analysis.releaseDate ? ` - ships ${analysis.releaseDate}` : ''}</Text>
            </Stack>
            <Stack space="space.050">
              <Text>{analysis.donePercent}% complete</Text>
              <Text>{analysis.byStatus.done}/{analysis.totalIssues} issues done</Text>
            </Stack>
          </Inline>

          <Box>
            <Text>Status breakdown</Text>
            <ProgressBar
              ariaLabel="completion"
              value={analysis.donePercent}
            />
            <Inline space="space.200">
              <Badge text={`${analysis.byStatus.todo} to do`} />
              <Badge text={`${analysis.byStatus.inprogress} in progress`} appearance="primary" />
              <Badge text={`${analysis.byStatus.done} done`} appearance="added" />
            </Inline>
          </Box>

          <Stack space="space.100">
            <Heading size="medium">Risks ({analysis.risks.length})</Heading>
            {analysis.risks.length === 0 ? (
              <EmptyState header="No structural risks" description="Nothing blocked, stale, unestimated or high-priority-unfinished in this version." />
            ) : (
              <DynamicTable
                head={{ cells: [
                  { content: 'Key' }, { content: 'Summary' }, { content: 'Status' },
                  { content: 'Assignee' }, { content: 'Why it is risky' },
                ] }}
                rows={analysis.risks.map((r) => RiskRow({ r }))}
              />
            )}
          </Stack>

          <Stack space="space.050">
            <Heading size="medium">Recommended next actions</Heading>
            {analysis.actions.map((a, i) => (
              <SectionMessage key={i} appearance="information"><Text>{a}</Text></SectionMessage>
            ))}
          </Stack>
        </Stack>
      )}
    </Stack>
  );
}

ForgeReconciler.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
