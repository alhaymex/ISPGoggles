import type { NonSpeedtestConfig, OoklaResult, SpeedtestConfig } from "./types";

const CONFIG: {
  rounds: number;
  restSecondsBetween: number;
  speedtest: SpeedtestConfig;
  nonSpeedtest: NonSpeedtestConfig;
} = {
  rounds: 5,
  restSecondsBetween: 3,
  nonSpeedtest: {
    secondsPerRound: 12,
    parallel: 6,
    chunkBytes: 8 * 1024 * 1024, // 8 MiB
    urls: [
      "https://fsn1-speed.hetzner.com/1GB.bin",
      "https://nbg1-speed.hetzner.com/1GB.bin",
      "https://hel1-speed.hetzner.com/1GB.bin",

      "https://www.thinkbroadband.com/download/1GB.zip",
    ],
  },
  speedtest: {
    enabled: true,
    command: "speedtest",
    args: ["-f", "json"],
  },
};

const mbpsFromBytesPerSecond = (bytesPerSeconds: number) => {
  return (bytesPerSeconds * 8) / 1e6;
};

const mean = (arr: number[]) => {
  return arr.reduce((a, b) => a + b, 0) / Math.max(1, arr.length);
};

const stdev = (arr: number[]) => {
  if (arr.length <= 1) return 0;

  const m = mean(arr);
  const v = mean(arr.map((x) => (x - m) ** 2));
  return Math.sqrt(v);
};

const randInt = (min: number, max: number) => {
  const range = max - min;

  const u32 = new Uint32Array(1);
  crypto.getRandomValues(u32);

  return min + (u32[0]! % range);
};

const measureNonSpeedtestMbps = async (
  cfg: NonSpeedtestConfig,
): Promise<number> => {
  const deadline = Date.now() + cfg.secondsPerRound * 1000;
  let totalBytes = 0;

  const workerUrls = Array.from(
    { length: cfg.parallel },
    (_, i) => cfg.urls[i % cfg.urls.length],
  );

  async function worker(url: string) {
    while (Date.now() < deadline) {
      // Random offset to avoid easy caching patterns
      const start = randInt(0, 512 * 1024 * 1024); // 0..512MiB
      const end = start + cfg.chunkBytes - 1;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      try {
        const res = await fetch(url, {
          method: "GET",
          headers: { Range: `bytes=${start}-${end}` },
          cache: "no-store",
          signal: controller.signal,
        });

        if (!res.ok || !res.body) continue;

        const reader = res.body.getReader();
        while (Date.now() < deadline) {
          const { value, done } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
        }
      } catch {
        // ignore transient failures
      } finally {
        clearTimeout(timeout);
      }
    }
  }

  await Promise.all(
    workerUrls.filter((url): url is string => !!url).map(worker),
  );

  const bytesPerSec = totalBytes / cfg.secondsPerRound;
  return mbpsFromBytesPerSecond(bytesPerSec);
};

const runOoklaSpeedtest = async (
  cfg: SpeedtestConfig,
): Promise<OoklaResult> => {
  const proc = Bun.spawn([cfg.command, ...cfg.args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `speedtest exited ${exitCode}. stderr:\n${stderr || "(none)"}`,
    );
  }

  const j = JSON.parse(stdout);

  // Ookla JSON uses bandwidth in BYTES/sec
  const downloadMbps = mbpsFromBytesPerSecond(j?.download?.bandwidth ?? 0);
  const uploadMbps = mbpsFromBytesPerSecond(j?.upload?.bandwidth ?? 0);

  return {
    downloadMbps,
    uploadMbps,
    latencyMs: j?.ping?.latency ?? null,
    jitterMs: j?.ping?.jitter ?? null,
    packetLoss: j?.packetLoss ?? null,
    server: j?.server ? `${j.server.name}, ${j.server.location}` : null,
    isp: j?.isp ?? null,
  };
};

const main = async () => {
  const non: number[] = [];
  const ooklaDown: number[] = [];
  const ooklaUp: number[] = [];

  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│                🥽     ISPGoggles                        │");
  console.log("│       Detecting Speedtest Traffic Prioritization        │");
  console.log("└─────────────────────────────────────────────────────────┘");

  console.log(
    `📡 Config: ${CONFIG.rounds} rounds | ${CONFIG.nonSpeedtest.parallel} parallel streams`,
  );
  console.log(
    `🔗 Target: ${CONFIG.nonSpeedtest.urls.length} non-prioritized endpoints`,
  );
  console.log(
    `🛠️  Speedtest CLI: ${CONFIG.speedtest.enabled ? "ACTIVE" : "DISABLED"}`,
  );
  console.log("─".repeat(58));

  for (let i = 1; i <= CONFIG.rounds; i++) {
    process.stdout.write(
      `\r[Round ${i}/${CONFIG.rounds}] Testing raw throughput...`,
    );

    const nonMbps = await measureNonSpeedtestMbps(CONFIG.nonSpeedtest);
    non.push(nonMbps);

    process.stdout.write(
      `\rRound ${i}/${CONFIG.rounds} | Raw: ${nonMbps.toFixed(2).padStart(7)} Mbps`,
    );

    if (CONFIG.speedtest.enabled) {
      try {
        const r = await runOoklaSpeedtest(CONFIG.speedtest);
        ooklaDown.push(r.downloadMbps);
        ooklaUp.push(r.uploadMbps);
        process.stdout.write(
          ` | Ookla: ${r.downloadMbps.toFixed(2).padStart(7)} Mbps\n`,
        );
      } catch (e: any) {
        console.log(`\n❌ Ookla failed: ${e?.message ?? String(e)}`);
      }
    } else {
      console.log("");
    }

    if (i !== CONFIG.rounds) {
      await Bun.sleep(CONFIG.restSecondsBetween * 1000);
    }
  }

  const nonAvg = mean(non);
  const nonStd = stdev(non);

  console.log("\n" + "═".repeat(58));
  console.log("📊 FINAL VERDICT");
  console.log("═".repeat(58));

  console.log(
    `Real-World Avg:    ${nonAvg.toFixed(2).padStart(8)} Mbps  (Stability σ=${nonStd.toFixed(2)})`,
  );

  if (ooklaDown.length) {
    const ooklaAvg = mean(ooklaDown);
    const ooklaStd = stdev(ooklaDown);
    const ratio = ooklaAvg / Math.max(1e-9, nonAvg);

    console.log(
      `Ookla Down Avg:    ${ooklaAvg.toFixed(2).padStart(8)} Mbps  (Stability σ=${ooklaStd.toFixed(2)})`,
    );
    console.log(
      `Traffic Bias:      ${ratio.toFixed(2).padStart(8)}x speed boost detected`,
    );
    console.log("─".repeat(58));

    // Analysis
    if (ratio >= 2) {
      console.log(
        "🚨 RESULT: HIGH BIAS. Your ISP is likely prioritizing Speedtest.",
      );
    } else if (ratio >= 1.3) {
      console.log("⚠️  RESULT: MILD BIAS. Possible traffic shaping detected.");
    } else {
      console.log("✅ RESULT: NEUTRAL. No significant prioritization found.");
    }

    if (nonStd > ooklaStd * 3) {
      console.log(
        "📉 PATTERN: Real traffic is significantly more jittery than benchmarks.",
      );
    }
  }

  console.log("═".repeat(58));
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
