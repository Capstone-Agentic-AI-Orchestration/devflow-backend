import { Module } from '@nestjs/common';
import { SupabaseModule } from '@app/supabase';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [SupabaseModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
