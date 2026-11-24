import { useEffect, useState, type ChangeEvent } from "react";
import { createPracticeBackup, importPracticeBackup, type PracticeBackupExport } from "../persistence/backupMerge";
import type { PracticeStoragePort } from "../persistence/storagePort";
import type { OpenChoice, OpenDecision } from "../persistence/studioPersistence";

const overlay = "fixed inset-0 z-50 flex items-center justify-center bg-slate-950/30 p-4";
const panel = "w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-800 shadow-xl";
const button = "rounded-md border border-slate-300 px-2.5 py-1.5 hover:bg-slate-50 disabled:opacity-50";

export function ScoreOpenChoice({ choice, onAnswer }: { choice: OpenChoice; onAnswer(answer: OpenDecision): void }) {
  const link = choice.kind === "link";
  return (
    <div className={overlay}>
      <section role="dialog" aria-modal="true" aria-label={link ? "关联练习曲目" : "发现不同指法"}
        data-testid={`practice-score-${choice.kind}-prompt`} className={panel}>
        <p>{link ? `此乐谱与「${choice.title}」相似。是否继续使用原曲目的练习记录？`
          : `「${choice.title}」在导入文件中的原谱指法已改变。请选择要使用的指法。`}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} data-testid="practice-score-choice-accept"
            onClick={() => onAnswer(link ? "link-existing" : "keep-local-draft")}>
            {link ? "关联已有曲目" : "保留本地草稿"}
          </button>
          <button type="button" className={button} data-testid="practice-score-choice-decline"
            onClick={() => onAnswer(link ? "open-as-new" : "adopt-imported")}>
            {link ? "作为新曲目" : "采纳导入指法"}
          </button>
        </div>
      </section>
    </div>
  );
}

interface PracticeBackupPanelProps {
  storage: PracticeStoragePort;
  onClose(): void;
  flush(): Promise<void>;
  onImported(): Promise<void>;
  onArchive?: () => Promise<void>;
}

function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }

export function PracticeBackupPanel({ storage, onClose, flush, onImported, onArchive }: PracticeBackupPanelProps) {
  const [backup, setBackup] = useState<PracticeBackupExport | null>(null);
  const [includeScores, setIncludeScores] = useState(true);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  useEffect(() => {
    let mounted = true;
    void flush().then(() => createPracticeBackup(storage)).then((result) => {
      if (mounted) setBackup(result);
    }).catch((error) => {
      if (mounted) setStatus(`无法读取本地备份：${errorText(error)}`);
    });
    return () => { mounted = false; };
  }, [storage]);

  const download = () => {
    if (!backup) return;
    const url = URL.createObjectURL(new Blob([includeScores ? backup.fullJson : backup.metadataOnlyJson], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `piano-practice-${includeScores ? "with-scores" : "data-only"}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setStatus("正在读取备份…");
    try {
      await flush();
      await importPracticeBackup(storage, await file.text());
      await onImported();
      setStatus("已导入备份。未随文件附带的乐谱可重新上传，匹配后会自动关联。");
      setBackup(await createPracticeBackup(storage));
    } catch (error) {
      setStatus(`无法导入备份：${errorText(error)}`);
    } finally { setBusy(false); }
  };

  const archive = async () => {
    if (!onArchive) return;
    setBusy(true);
    try {
      await onArchive();
      await flush();
      setBackup(await createPracticeBackup(storage));
      setStatus("已归档原练习记录，并为当前乐谱开始新的练习记录。");
    } catch (error) {
      setStatus(`无法归档曲目：${errorText(error)}`);
    } finally {
      setBusy(false);
      setConfirmArchive(false);
    }
  };

  return (
    <div className={overlay}>
      <section role="dialog" aria-modal="true" aria-label="本地练习备份" className={panel}>
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">本地练习备份</h2>
          <button type="button" className={button} aria-label="关闭备份" disabled={busy} onClick={onClose}>关闭</button>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" data-testid="practice-backup-include-scores" checked={includeScores}
            onChange={(event) => setIncludeScores(event.target.checked)} /> 携带缓存乐谱（单文件恢复）
        </label>
        <div className="text-xs text-slate-600">
          含乐谱：<output data-testid="practice-backup-full-size">{backup ? `${backup.fullBytes.toLocaleString()} B` : "…"}</output>
          <span className="mx-2">·</span>
          纯数据：<output data-testid="practice-backup-data-size">{backup ? `${backup.metadataOnlyBytes.toLocaleString()} B` : "…"}</output>
        </div>
        {Boolean(backup?.skippedScores) && <p className="text-xs text-slate-500">超过 2 MB 的乐谱仅备份练习数据。</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} data-testid="practice-backup-download" disabled={busy || !backup} onClick={download}>
            导出 JSON
          </button>
          <label className={`${button} cursor-pointer ${busy ? "opacity-50" : ""}`}>
            导入 JSON
            <input type="file" className="sr-only" accept=".json,application/json" data-testid="practice-backup-import"
              disabled={busy} onChange={(event) => void importFile(event)} />
          </label>
        </div>
        {onArchive && !confirmArchive && (
          <button type="button" className={button} disabled={busy} data-testid="practice-archive-piece"
            onClick={() => setConfirmArchive(true)}>归档当前曲目并重新开始</button>
        )}
        {confirmArchive && <div className="space-y-2 border-t border-slate-200 pt-2">
          <p>旧练习记录和指法草稿会保留在备份中；当前乐谱将以新的练习记录开始。</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={button} disabled={busy} data-testid="practice-archive-confirm"
              onClick={() => void archive()}>确认归档并重新开始</button>
            <button type="button" className={button} disabled={busy} onClick={() => setConfirmArchive(false)}>取消</button>
          </div>
        </div>}
        <p aria-live="polite" data-testid="practice-backup-status" className="text-xs text-slate-600">{status}</p>
      </section>
    </div>
  );
}
