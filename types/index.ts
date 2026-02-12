export type SpeedtestConfig = {
  enabled: boolean;
  command: string;
  args: string[];
};

export type NonSpeedtestConfig = {
  secondsPerRound: number;
  parallel: number;
  chunkBytes: number;
  urls: string[];
};

export type OoklaResult = {
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number | null;
  jitterMs: number | null;
  packetLoss: number | null;
  server: string | null;
  isp: string | null;
};
