import type { PairingCode } from "@agent-flow/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { jsonBody, request } from "./api";
import {
  EmptyState,
  ErrorNotice,
  Field,
  Loading,
  Modal,
  Page,
  ShortId,
  Time,
} from "./components";
import { workersQuery } from "./queries";

export function WorkersPage() {
  const workers = useQuery(workersQuery);
  const [pairing, setPairing] = useState(false);
  const [name, setName] = useState("");
  const [now, setNow] = useState(Date.now());
  const pair = useMutation({
    mutationFn: () =>
      request<PairingCode>("/workers/pairing", {
        method: "POST",
        body: jsonBody({ name: name || undefined }),
      }),
  });
  useEffect(() => {
    if (!pair.data) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [pair.data]);
  const expired = pair.data ? now >= Date.parse(pair.data.expiresAt) : false;
  return (
    <Page
      title="Workers"
      description="连接你的本地执行环境，让任务在熟悉的仓库中推进。"
      actions={
        <button
          className="button primary"
          type="button"
          onClick={() => {
            pair.reset();
            setName("");
            setPairing(true);
          }}
        >
          ＋ 连接 Worker
        </button>
      }
    >
      <div className="section-subline">
        <span className="status-dot online" />
        <span>
          {workers.data?.filter((worker) => worker.online).length ?? 0} 个在线
        </span>
        <span className="separator">/</span>
        <span>{workers.data?.length ?? 0} 个已配对</span>
      </div>
      <ErrorNotice error={workers.error} retry={() => void workers.refetch()} />
      {workers.isPending ? (
        <Loading />
      ) : workers.data?.length ? (
        <div className="worker-grid">
          {workers.data.map((worker) => (
            <article className="worker-card" key={worker.id}>
              <div className="card-topline">
                <div className="worker-icon" aria-hidden="true">
                  ▤
                </div>
                <span
                  className={`worker-status ${worker.online ? "online" : "offline"}`}
                >
                  <span
                    className={`status-dot ${worker.online ? "online" : ""}`}
                  />
                  {worker.online ? "在线" : "离线"}
                </span>
              </div>
              <h3>{worker.name}</h3>
              <ShortId value={worker.id} />
              <div className="capabilities">
                {worker.capabilities.map((capability) => (
                  <span className="tag" key={capability}>
                    {capability}
                  </span>
                ))}
                {!worker.capabilities.length && (
                  <span className="muted">尚未报告执行能力</span>
                )}
              </div>
              <dl className="worker-properties">
                <div>
                  <dt>执行容量</dt>
                  <dd>{worker.capacity} 个槽位</dd>
                </div>
                <div>
                  <dt>最近心跳</dt>
                  <dd>
                    <Time value={worker.lastHeartbeat} />
                  </dd>
                </div>
                <div>
                  <dt>当前执行</dt>
                  <dd>
                    {worker.currentRunId ? (
                      <Link
                        className="inline-link"
                        to="/runs/$runId"
                        params={{ runId: worker.currentRunId }}
                      >
                        <ShortId value={worker.currentRunId} /> ↗
                      </Link>
                    ) : worker.online ? (
                      "空闲，等待任务"
                    ) : (
                      "等待重新连接"
                    )}
                  </dd>
                </div>
              </dl>
              {!worker.online && worker.currentRunId && (
                <div className="notice warning">
                  连接中断，执行结果尚未确认。
                </div>
              )}
            </article>
          ))}
        </div>
      ) : (
        !workers.isError && (
          <EmptyState
            symbol="▤"
            title="把本地环境连接进来"
            description="在 Herdr 中启动一个 Worker，配对后即可从任务详情发起执行。"
            action={
              <button
                className="button primary"
                type="button"
                onClick={() => {
                  pair.reset();
                  setPairing(true);
                }}
              >
                连接第一个 Worker
              </button>
            }
          />
        )
      )}
      {pairing && (
        <Modal title="连接 Worker" onClose={() => setPairing(false)}>
          {!pair.data ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                pair.mutate();
              }}
            >
              <p className="dialog-copy">
                创建一次性配对码，然后在运行 Worker 的 Herdr 环境中完成配对。
              </p>
              <Field label="Worker 名称（可选）">
                <input
                  maxLength={200}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="例如：我的 Mac"
                />
              </Field>
              <ErrorNotice error={pair.error} />
              <div className="form-actions">
                <button
                  className="button"
                  type="button"
                  onClick={() => setPairing(false)}
                >
                  取消
                </button>
                <button
                  type="submit"
                  className="button primary"
                  disabled={pair.isPending}
                >
                  {pair.isPending ? "生成中…" : "生成配对码"}
                </button>
              </div>
            </form>
          ) : (
            <>
              <p className="dialog-copy">
                在 Worker 的配对命令中使用以下一次性凭证。
              </p>
              <div
                className={`pairing-code ${expired ? "expired" : ""}`}
                role="status"
                aria-label="一次性配对码"
              >
                {pair.data.code}
              </div>
              <p className="field-hint">
                {expired ? (
                  "配对码已过期，请重新生成。"
                ) : (
                  <>
                    有效期至 <Time value={pair.data.expiresAt} /> · 仅可使用一次
                  </>
                )}
              </p>
              <div className="pair-instructions">
                <h3>在 Herdr 中启动</h3>
                <p>
                  完成 Worker 的数据库、服务地址与仓库配置后，使用配对码启动
                  Worker。
                </p>
                <code>bun run worker:pair --code {pair.data.code}</code>
                <p>
                  配对成功后，Worker 会出现在列表中。后续重启使用已保存的身份。
                </p>
              </div>
              <ErrorNotice error={pair.error} />
              <div className="form-actions">
                <button
                  className="button"
                  type="button"
                  disabled={pair.isPending}
                  onClick={() => {
                    setNow(Date.now());
                    pair.mutate();
                  }}
                >
                  重新生成
                </button>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => {
                    setPairing(false);
                    void workers.refetch();
                  }}
                >
                  完成
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
    </Page>
  );
}
