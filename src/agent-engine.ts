/**
 * Handcrew's built-in agent engine.
 *
 * Deliberately local and deterministic: the core experience (forging, teaming,
 * handing off, human approval) works with no third-party service, network or
 * API key. Each role transforms the previous agent's output, so a crew of
 * different shapes produces visibly different work for the same task.
 */
export type RoleId = 'scout' | 'builder' | 'scribe' | 'critic';

export interface RoleDef {
  id: RoleId;
  title: string;
  color: string;
  names: string[];
  greeting: string;
  idle: string;
}

/** Pipeline order is the order roles appear here. */
export const ROLES: RoleDef[] = [
  { id: 'scout', title: 'Scout', color: '#4fc3f7', names: ['Ivy', 'Rook', 'Juno', 'Pip'], greeting: 'Scout online. I dig up facts.', idle: 'Ready to research.' },
  { id: 'builder', title: 'Builder', color: '#66bb6a', names: ['Bolt', 'Moss', 'Kit', 'Tess'], greeting: 'Builder online. I make plans real.', idle: 'Tools sharpened.' },
  { id: 'scribe', title: 'Scribe', color: '#ba68c8', names: ['Quill', 'Wren', 'Lumi', 'Ode'], greeting: 'Scribe online. I turn work into words.', idle: 'Ink ready.' },
  { id: 'critic', title: 'Critic', color: '#ffa726', names: ['Vex', 'Sage', 'Nyx', 'Hale'], greeting: 'Critic online. I catch what you miss.', idle: 'Watching closely.' },
];

export interface TaskDef {
  title: string;
  blurb: string;
  facts: string[];
  build: string;
  draft: string;
  risk: string;
  fix: string;
}

export const TASKS: TaskDef[] = [
  {
    title: 'Plan a team offsite',
    blurb: '12 people, 1 day, low budget',
    facts: ['3 venues under £40/head within 30 min by train', 'Thursday has the best availability', '2 people need step-free access'],
    build: 'Agenda: 10:00 kickoff, 11:30 workshop, 13:00 lunch, 15:00 walk, 17:00 retro.',
    draft: '"Join us Thursday for a day of building, food and fresh air — step-free venue, back by 6."',
    risk: 'The walk at 15:00 excludes the 2 colleagues who need step-free access.',
    fix: 'Swapped the walk for a riverside café session — fully step-free.',
  },
  {
    title: 'Launch post for our app',
    blurb: 'One post, 280 characters',
    facts: ['Top-performing launch posts lead with a demo GIF', 'Best window: Tue–Thu, 9–11am', 'Hashtags beyond 2 reduce reach'],
    build: 'Asset list: 6s demo GIF, 1 hook line, 1 link, 2 hashtags.',
    draft: '"Your AI crew now fits in your hands. Forge agents, team them up, ship work — no controllers. Try it today."',
    risk: '"Try it today" has no link — readers cannot act on it.',
    fix: 'Added the link and a clear verb: "Build your crew →".',
  },
  {
    title: 'Fix the login bug',
    blurb: 'Users logged out after 5 min',
    facts: ['Session TTL is 300s in config', 'Refresh token call fails silently on 401', 'Started after Tuesday deploy'],
    build: 'Patch: refresh token 60s before expiry; surface 401 as an error, not a blank state.',
    draft: 'Changelog: "Fixed unexpected logouts. Sessions now refresh in the background."',
    risk: 'The patch has no test — the same bug could return silently.',
    fix: 'Added a test that fast-forwards the clock past TTL and asserts the session survives.',
  },
  {
    title: 'Morning brief',
    blurb: 'What matters today, in 3 lines',
    facts: ['2 meetings, 1 deadline at 17:00', 'Inbox: 1 urgent reply from finance', 'Rain from 14:00'],
    build: 'Priority order: finance reply → deadline work block 10–13 → meetings.',
    draft: '"Reply to finance first, protect 10–13 for the deadline, take an umbrella after lunch."',
    risk: 'No break scheduled between 10:00 and 17:00.',
    fix: 'Added a 20-minute break at 13:00 before the first meeting.',
  },
];

export interface StepResult {
  line: string;
  needsApproval?: boolean;
  approvedLine?: string;
  revisedLine?: string;
}

/**
 * One agent's contribution. `prev` is the previous agent's transcript line,
 * so later agents visibly build on earlier ones.
 */
export function runStep(role: RoleId, taskIndex: number, _step: number, prev: string | null): StepResult {
  const t = TASKS[taskIndex];
  switch (role) {
    case 'scout':
      return { line: `Found: ${t.facts.join('; ')}.` };
    case 'builder':
      return {
        line: `${t.build} Shall I lock this in?`,
        needsApproval: true,
        approvedLine: `Locked in. ${t.build}`,
        revisedLine: `Reworked with more slack: ${t.build.replace(/\.$/, '')}, plus a buffer.`,
      };
    case 'scribe':
      return { line: prev ? `Draft: ${t.draft}` : `Draft (no research yet — add a Scout!): ${t.draft}` };
    case 'critic':
      return {
        line: `Risk: ${t.risk} Fix it before shipping?`,
        needsApproval: true,
        approvedLine: `Fixed. ${t.fix}`,
        revisedLine: `Revised deeper: ${t.fix} Added a follow-up check so it can't slip back in.`,
      };
  }
}
