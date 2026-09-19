/* Pipeline Runner — invokes deployed Supabase Edge Functions in sequence
 * from the operator console: normalizer -> screener -> matcher -> tailor -> auditor.
 */

import { supabase } from './supabase';

export interface PipelineStepProgress {
  readonly agent: 'normalizer' | 'screener' | 'matcher' | 'tailor' | 'auditor';
  readonly status: 'pending' | 'running' | 'succeeded' | 'failed';
  readonly message?: string;
}

export interface PipelineRunResult {
  readonly ok: boolean;
  readonly summary: string;
  readonly steps: readonly PipelineStepProgress[];
}

export async function runFullPipeline(
  onProgress?: (currentAgent: string, stepInfo: string) => void,
): Promise<PipelineRunResult> {
  if (supabase === null) {
    return {
      ok: false,
      summary: 'Supabase client is not configured.',
      steps: [],
    };
  }

  const agents: ReadonlyArray<{
    readonly id: 'normalizer' | 'screener' | 'matcher' | 'tailor' | 'auditor';
    readonly name: string;
    readonly desc: string;
  }> = [
    { id: 'normalizer', name: 'Normalizer', desc: 'Deduplicating discovered jobs & canonical fingerprinting' },
    { id: 'screener', name: 'Screener', desc: 'Applying deterministic tech gate & rule cascade' },
    { id: 'matcher', name: 'Matcher', desc: 'Scoring match fitness against Master Profile with Gemini' },
    { id: 'tailor', name: 'Tailor', desc: 'Assembling truthful tailored resumes with node references' },
    { id: 'auditor', name: 'Auditor', desc: 'Auditing anti-fabrication and advancing to Approval Queue' },
  ];

  const steps: PipelineStepProgress[] = [];

  for (const agent of agents) {
    onProgress?.(agent.name, `Running ${agent.name}: ${agent.desc}...`);

    try {
      const { data, error } = await supabase.functions.invoke(agent.id, {
        body: { limit: 10 },
      });

      if (error) {
        steps.push({
          agent: agent.id,
          status: 'failed',
          message: error.message,
        });
        onProgress?.(agent.name, `Failed: ${error.message}`);
      } else {
        const detail = data && typeof data === 'object' ? JSON.stringify(data) : 'Complete';
        steps.push({
          agent: agent.id,
          status: 'succeeded',
          message: detail,
        });
        onProgress?.(agent.name, `Completed successfully.`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      steps.push({
        agent: agent.id,
        status: 'failed',
        message: msg,
      });
      onProgress?.(agent.name, `Error: ${msg}`);
    }
  }

  return {
    ok: true,
    summary: 'Pipeline run complete. Check Approval Queue for tailored jobs ready for review.',
    steps,
  };
}
