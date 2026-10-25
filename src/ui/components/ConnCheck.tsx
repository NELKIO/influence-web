import { useState } from 'preact/hooks';
import { t } from '../../i18n';
import { connReport, connVerdict, runConnectionCheck, type CheckResult } from '../../net/connCheck';

const LABEL: Record<CheckResult['group'], 'ccPeerjs' | 'ccStun' | 'ccPeerRelay' | 'ccNostr' | 'ccMqtt'> = {
  peerjs: 'ccPeerjs',
  stun: 'ccStun',
  peerrelay: 'ccPeerRelay',
  nostr: 'ccNostr',
  mqtt: 'ccMqtt',
};

function status(r: CheckResult): { text: string; color: string } {
  if (r.ok === null) return { text: t('ccWait'), color: 'var(--muted)' };
  if (!r.ok) return { text: r.detail && r.detail !== 'timeout' && r.detail !== 'closed' ? t('ccRefused') : t('ccFail'), color: 'var(--bad)' };
  const ms = r.ms === null ? '' : t('ccOk', { ms: r.ms });
  if (r.detail === 'symmetric') return { text: `${ms} · ${t('ccSymmetric')}`, color: 'var(--warn)' };
  return { text: ms, color: 'var(--good)' };
}

/** Settings → «Проверка связи»: run every path check and show the verdict in plain words. */
export function ConnCheckPanel() {
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [copied, setCopied] = useState(false);
  const run = async () => {
    if (running) return;
    setRunning(true);
    setCopied(false);
    try {
      await runConnectionCheck((r) => setResults(r));
    } finally {
      setRunning(false);
    }
  };
  const verdict = results && !running ? connVerdict(results) : null;
  const line = verdict ? (verdict.direct ? t('ccVerdictDirect') : verdict.relay ? t('ccVerdictRelay') : t('ccVerdictNone')) : null;
  return (
    <div class="list-item" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }} data-testid="conn-check">
      <div class="muted" style={{ fontSize: 12 }}>
        {t('connCheckDesc')}
      </div>
      {results && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
          {results.map((r) => {
            const s = status(r);
            return (
              <div key={r.id} data-testid="cc-row" data-group={r.group} data-ok={String(r.ok)} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {t(LABEL[r.group])}
                  {r.group === 'nostr' || r.group === 'mqtt' ? <span class="muted">{` · ${r.target}`}</span> : null}
                </span>
                <span style={{ color: s.color, fontWeight: 600, whiteSpace: 'nowrap' }}>{s.text}</span>
              </div>
            );
          })}
        </div>
      )}
      {line && (
        <div
          data-testid="cc-verdict"
          data-direct={String(verdict!.direct)}
          data-relay={String(verdict!.relay)}
          style={{ fontWeight: 700, color: verdict!.direct || verdict!.relay ? 'var(--text)' : 'var(--bad)' }}
        >
          {line}
        </div>
      )}
      {line && (
        <div class="muted" style={{ fontSize: 11 }}>
          {t('ccNote')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button class="btn small" data-testid="cc-run" disabled={running} onClick={() => void run()}>
          {running ? t('ccWait') : results ? t('connCheckAgain') : t('connCheckRun')}
        </button>
        {line && results && (
          <button
            class="btn small ghost"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(connReport(results, line))
                .then(() => setCopied(true))
                .catch(() => {});
            }}
          >
            {copied ? t('connCheckCopied') : t('connCheckCopy')}
          </button>
        )}
      </div>
    </div>
  );
}
