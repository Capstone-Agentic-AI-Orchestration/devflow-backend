import { Injectable } from '@nestjs/common';
import { SupabaseService } from '@app/supabase';

export type HealthStatus = 'ok' | 'error';

export interface HealthChecks {
  database: boolean;
}

export interface HealthResponse {
  status: HealthStatus;
  uptimeSeconds: number;
  checks: HealthChecks;
}

@Injectable()
export class HealthService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async getStatus(): Promise<HealthResponse> {
    const [dbResult] = await Promise.allSettled([this.supabaseService.ping()]);

    const database = dbResult.status === 'fulfilled' ? dbResult.value : false;
    const status: HealthStatus = database ? 'ok' : 'error';

    return {
      status,
      uptimeSeconds: Math.floor(process.uptime()),
      checks: { database },
    };
  }
}
