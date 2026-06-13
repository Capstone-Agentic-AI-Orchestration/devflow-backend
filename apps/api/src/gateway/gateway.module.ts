import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DevFlowGateway } from './devflow.gateway';

@Module({
  // AuthModule exports SupabaseAuthService, which the gateway requires for
  // handshake token verification. PrismaService is global and needs no import.
  imports: [AuthModule],
  providers: [DevFlowGateway],
  // Export so OrchestrationModule can inject DevFlowGateway into OrchestrationService
  exports: [DevFlowGateway],
})
export class GatewayModule {}
