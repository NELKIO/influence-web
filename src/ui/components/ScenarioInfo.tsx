import { t, type Key } from '../../i18n';
import { DAILY_LEGACY_DESC, type ScenarioId, type ScenarioMeta } from '../../core/scenarios';
import { IconCrowd, IconDice, IconFlag, IconLink, IconMoon, IconMoonSolid, IconPoint, IconUsers } from './icons';

/** What sets a scenario apart from an ordinary battle, in the order it is listed. */
export type RuleKey = 'varied' | 'blind' | 'darkness' | 'objectives' | 'crowded' | 'unions';

export type RuleFlags = Partial<Record<RuleKey, boolean>>;

/** The special rules among these flags (absolute darkness stands for darkness too). */
export function ruleKeys(f: RuleFlags): RuleKey[] {
  const keys: RuleKey[] = [];
  if (f.varied) keys.push('varied');
  if (f.blind) keys.push('blind');
  else if (f.darkness) keys.push('darkness');
  if (f.objectives) keys.push('objectives');
  if (f.crowded) keys.push('crowded');
  if (f.unions) keys.push('unions');
  return keys;
}

/** A scenario's description; a map of the day built by a frozen older design keeps the text of that design. */
export function scenarioDesc(id: ScenarioId, daily: boolean): string {
  return daily && DAILY_LEGACY_DESC.has(id) ? t(`puzzleDescDaily_${id}` as 'puzzleDescDaily_sparks') : t(`puzzleDesc_${id}` as 'puzzleDesc_siege');
}

/** The rules a scenario fixes by itself (unions only when it plays with them whatever you choose). */
export function metaRules(m: ScenarioMeta): RuleKey[] {
  return ruleKeys({ varied: m.varied, blind: m.blind, darkness: m.darkness, objectives: m.objectives, crowded: m.crowded, unions: m.unions });
}

const LABEL: Record<RuleKey, Key> = {
  varied: 'scenarioVaried',
  blind: 'absoluteDarkness',
  darkness: 'darkness',
  objectives: 'frontierPoints',
  crowded: 'crowded',
  unions: 'unions',
};

const LEGEND: Record<RuleKey, Key> = {
  varied: 'legendVaried',
  blind: 'legendBlind',
  darkness: 'legendDarkness',
  objectives: 'legendPoints',
  crowded: 'legendCrowded',
  unions: 'legendUnions',
};

const DESC: Record<RuleKey, Key> = {
  varied: 'scenarioVariedDesc',
  blind: 'absoluteDarknessDesc',
  darkness: 'darknessDesc',
  objectives: 'scenarioPointsDesc',
  crowded: 'crowdedDesc',
  unions: 'unionsDesc',
};

export const ruleLabel = (k: RuleKey) => t(LABEL[k]);

export function RuleIcon({ k, size = 14 }: { k: RuleKey; size?: number }) {
  const p = { width: size, height: size, 'aria-hidden': true as const };
  switch (k) {
    case 'varied':
      return <IconDice {...p} />;
    case 'blind':
      return <IconMoonSolid {...p} />;
    case 'darkness':
      return <IconMoon {...p} />;
    case 'objectives':
      return <IconPoint {...p} />;
    case 'crowded':
      return <IconCrowd {...p} />;
    case 'unions':
      return <IconLink {...p} />;
  }
}

/** Difficulty 1..5 as five short bars (the map of the day shows its level the same way). */
export function Pips({ level }: { level: number }) {
  return (
    <span class="pips" role="img" aria-label={t('scenarioLevel', { n: level })} title={t('scenarioLevel', { n: level })} data-level={level}>
      {[1, 2, 3, 4, 5].map((k) => (
        <i key={k} class={k <= level ? 'on' : ''} />
      ))}
    </span>
  );
}

/** Seats of a scenario: "3", or "2–6" when you choose how many. */
export const seatsText = (m: ScenarioMeta) => (m.configurable ? `${m.configurable.seats[0]}–${m.configurable.seats[1]}` : String(m.players.length));

/** The compact line under a gallery card: seats, then an icon per special rule. */
export function CardTags({ meta }: { meta: ScenarioMeta }) {
  return (
    <span class="card-tags">
      {/* `.meta` holds the seats alone (its text is the number of seats) */}
      <span class="meta" data-seats={seatsText(meta)} aria-label={t('scenarioSeatsLabel', { n: seatsText(meta) })}>
        <IconUsers width={12} height={12} aria-hidden="true" />
        {seatsText(meta)}
      </span>
      {metaRules(meta).map((k) => (
        <span key={k} class={`rtag tag-${k}`} data-tag={k} role="img" aria-label={ruleLabel(k)} title={ruleLabel(k)}>
          <RuleIcon k={k} size={11} />
        </span>
      ))}
    </span>
  );
}

/** What the icons on the gallery cards mean (only those some card shows). */
export function TagLegend({ keys }: { keys: RuleKey[] }) {
  return (
    <div class="tag-legend" data-testid="tag-legend">
      <span class="item">
        <Pips level={3} /> {t('legendLevel')}
      </span>
      {keys.map((k) => (
        <span key={k} class="item">
          <span class={`rtag tag-${k}`} aria-hidden="true">
            <RuleIcon k={k} size={11} />
          </span>
          {t(LEGEND[k])}
        </span>
      ))}
    </div>
  );
}

/** The goal of a scenario match: hold the control points, or beat everybody. */
export function goalText(points: { k: number; n: number } | null): string {
  return points ? t('scenarioGoalPoints', points) : t('scenarioGoalAll');
}

/** A rule as a chip (the chosen scenario card). */
export function RuleChip({ k }: { k: RuleKey }) {
  return (
    <span class={`chip tag-${k} ${k === 'darkness' || k === 'blind' ? 'dark' : ''}`} data-tag={k}>
      <RuleIcon k={k} size={13} /> {k === 'varied' ? t('scenarioVariedChip') : ruleLabel(k)}
    </span>
  );
}

/** One line with the goal. */
export function GoalLine({ text }: { text: string }) {
  return (
    <div class="scenario-goal" data-testid="scenario-goal">
      <IconFlag width={15} height={15} aria-hidden="true" />
      <span>
        <b>{t('scenarioGoal')}:</b> {text}
      </span>
    </div>
  );
}

/**
 * The goal and the special rules, read-only (the modes step of a scenario, the in-game info).
 * `notes` replaces the explanation of a rule (unions that cannot work with several people).
 */
export function RulesList({ keys, goal, notes = {} }: { keys: RuleKey[]; goal: string; notes?: Partial<Record<RuleKey, string>> }) {
  return (
    <div class="list rules-list" data-testid="scenario-rules">
      <div class="list-item rule-row" data-rule="goal">
        <span class="rule-icon goal">
          <IconFlag width={16} height={16} aria-hidden="true" />
        </span>
        <div class="grow">
          <div class="title">{t('scenarioGoal')}</div>
          <div class="desc">{goal.charAt(0).toUpperCase() + goal.slice(1)}</div>
        </div>
      </div>
      {keys.map((k) => (
        <div key={k} class="list-item rule-row" data-rule={k}>
          <span class={`rule-icon tag-${k}`}>
            <RuleIcon k={k} size={16} />
          </span>
          <div class="grow">
            <div class="title">{ruleLabel(k)}</div>
            <div class="desc">{notes[k] ?? t(DESC[k])}</div>
          </div>
        </div>
      ))}
      {keys.length === 0 && (
        <div class="list-item rule-row" data-rule="plain">
          <span class="rule-icon" />
          <div class="grow">
            <div class="title">{t('scenarioPlain')}</div>
            <div class="desc">{t('scenarioPlainDesc')}</div>
          </div>
        </div>
      )}
    </div>
  );
}
