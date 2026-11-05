// The agents' settings, read from the host's environment. Secrets (PING_KEY, MODEL_KEY) are
// read here and passed on only to the code that needs them; nothing here logs them.
export type AgentsEnv = {
  ownerCode: string;
  pingKeys: string[]; // whsec_... values; two during a key change
  courseOrigin: string; // e.g. https://hq.mega.dev
  modelBaseUrl: string;
  modelKey: string;
  pulseModel: string;
  testModel: string;
  dailyModelCalls: number;
  repoDir: string;
};

export function agentsEnv(env: NodeJS.ProcessEnv = process.env): AgentsEnv {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new Error(`missing env ${k}`);
    return v;
  };
  return {
    ownerCode: need('OWNER_CODE'),
    pingKeys: [env.PING_KEY, env.PING_KEY_NEXT].map((k) => k?.trim()).filter((k): k is string => !!k),
    courseOrigin: new URL(need('COURSE_ORIGIN')).origin,
    modelBaseUrl: env.MODEL_BASE_URL?.trim() || 'https://api.openai.com/v1',
    modelKey: env.MODEL_KEY?.trim() ?? '',
    pulseModel: env.PULSE_MODEL?.trim() ?? '',
    testModel: env.TEST_MODEL?.trim() ?? '',
    dailyModelCalls: Number(env.DAILY_MODEL_CALLS ?? 20),
    repoDir: env.REPO_DIR?.trim() || process.cwd(),
  };
}
