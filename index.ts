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

  console.log("=== net-bias-check (Bun + TS) ===");
  console.log(`Rounds: ${CONFIG.rounds}`);
  console.log(
    `Non-Speedtest: ${CONFIG.nonSpeedtest.secondsPerRound}s | parallel=${CONFIG.nonSpeedtest.parallel} | chunk=${(CONFIG.nonSpeedtest.chunkBytes / (1024 * 1024)).toFixed(1)} MiB`,
  );
  console.log(
    `Speedtest: ${CONFIG.speedtest.enabled ? "enabled" : "disabled"}`,
  );
  console.log("");

  for (let i = 1; i <= CONFIG.rounds; i++) {
    console.log(`--- Round ${i}/${CONFIG.rounds} ---`);

    const nonMbps = await measureNonSpeedtestMbps(CONFIG.nonSpeedtest);
    non.push(nonMbps);
    console.log(`Non-Speedtest download: ${nonMbps.toFixed(2)} Mbps`);

    if (CONFIG.speedtest.enabled) {
      try {
        const r = await runOoklaSpeedtest(CONFIG.speedtest);
        ooklaDown.push(r.downloadMbps);
        ooklaUp.push(r.uploadMbps);

        console.log(`Ookla download:        ${r.downloadMbps.toFixed(2)} Mbps`);
        console.log(`Ookla upload:          ${r.uploadMbps.toFixed(2)} Mbps`);
        if (r.latencyMs != null)
          console.log(
            `Latency/Jitter:        ${r.latencyMs} ms / ${r.jitterMs} ms`,
          );
        if (r.packetLoss != null)
          console.log(`Packet loss:           ${r.packetLoss}%`);
        if (r.server) console.log(`Server:                ${r.server}`);
        if (r.isp) console.log(`ISP (reported):         ${r.isp}`);
      } catch (e: any) {
        console.log(
          `Ookla speedtest failed this round: ${e?.message ?? String(e)}`,
        );
      }
    }

    if (i !== CONFIG.rounds) {
      console.log(`Resting ${CONFIG.restSecondsBetween}s...\n`);
      await Bun.sleep(CONFIG.restSecondsBetween * 1000);
    }
  }

  console.log("\n=== Summary ===");
  console.log(
    `Non-Speedtest avg:   ${mean(non).toFixed(2)} Mbps (σ=${stdev(non).toFixed(2)})`,
  );

  if (ooklaDown.length) {
    const nonAvg = mean(non);
    const nonStd = stdev(non);

    const ooklaAvg = mean(ooklaDown);
    const ooklaStd = stdev(ooklaDown);

    const ooklaUpAvg = mean(ooklaUp);
    const ooklaUpStd = stdev(ooklaUp);

    const ratio = ooklaAvg / Math.max(1e-9, nonAvg);

    console.log(
      `Ookla down avg:      ${ooklaAvg.toFixed(2)} Mbps (σ=${ooklaStd.toFixed(2)})`,
    );
    console.log(
      `Ookla up avg:        ${ooklaUpAvg.toFixed(2)} Mbps (σ=${ooklaUpStd.toFixed(2)})`,
    );
    console.log(`Ratio (Ookla/Non):   ${ratio.toFixed(2)}x`);

    // Analytics

    console.log("\n=== Analysis ===");

    const nonRelStd = nonStd / Math.max(1e-9, nonAvg);
    const ooklaRelStd = ooklaStd / Math.max(1e-9, ooklaAvg);

    // Ratio signal
    if (ratio >= 3) {
      console.log(
        "🚨 Very strong signal of traffic prioritization or shaping.",
      );
      console.log(
        `   Speedtest traffic is ~${ratio.toFixed(2)}x faster than normal HTTPS traffic.`,
      );
    } else if (ratio >= 2) {
      console.log(
        "⚠️ Strong signal of possible traffic prioritization or QoS differences.",
      );
      console.log(`   Speedtest traffic is ~${ratio.toFixed(2)}x faster.`);
    } else if (ratio >= 1.5) {
      console.log(
        "⚠️ Mild signal of possible prioritization or routing differences.",
      );
      console.log(`   Speedtest traffic is ~${ratio.toFixed(2)}x faster.`);
    } else {
      console.log(
        "✅ No strong evidence of prioritization based on throughput ratio.",
      );
    }

    // Stability pattern
    if (nonRelStd > 0.08 && ooklaRelStd < 0.02) {
      console.log(
        "📉 Non-speedtest traffic is unstable while speedtest traffic is very stable.",
      );
      console.log(
        "   This pattern often indicates QoS classification or managed traffic lanes.",
      );
    } else if (nonRelStd > 0.08) {
      console.log("📉 Non-speedtest traffic shows noticeable instability.");
    }

    if (ooklaRelStd < 0.01) {
      console.log(
        "📈 Speedtest traffic is extremely stable (very low variance).",
      );
    }

    if (ratio > 3 && ooklaRelStd < nonRelStd) {
      console.log(
        "🧠 Pattern strongly matches known ISP speedtest prioritization behavior.",
      );
    }

    console.log("\nSummary:");
    console.log(
      `   Non-Speedtest: ${nonAvg.toFixed(2)} Mbps ± ${nonStd.toFixed(2)}`,
    );
    console.log(
      `   Speedtest:     ${ooklaAvg.toFixed(2)} Mbps ± ${ooklaStd.toFixed(2)}`,
    );
    console.log(`   Ratio:         ${ratio.toFixed(2)}x`);
  } else {
    console.log(
      "No Ookla results collected. Install Ookla `speedtest` CLI or disable it in CONFIG.speedtest.enabled.",
    );
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
