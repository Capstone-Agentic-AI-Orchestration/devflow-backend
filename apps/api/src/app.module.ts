import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.schema';
import configuration from './config/configuration';
import { PrismaModule } from '@app/prisma';
import { CorrelationIdMiddleware } from '@app/common';
import { ProjectsModule } from './projects/projects.module';
import { OrchestrationModule } from './orchestration/orchestration.module';
import { GithubModule } from './github/github.module';
import { SupervisorModule } from './supervisor/supervisor.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { GatewayModule } from './gateway/gateway.module';
import { ProfilesModule } from './profiles/profiles.module';
import { NotificationsModule } from './notifications/notifications.module';
import { CollaborationModule } from './collaboration/collaboration.module';
import { InquiriesModule } from './inquiries/inquiries.module';
import { ClientInvitesModule } from './client-invites/client-invites.module';
import { HealthModule } from './health/health.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      load: [configuration],
      validate: validateEnv,
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    GithubModule,
    GatewayModule,
    OrchestrationModule,
    SupervisorModule,
    ProjectsModule,
    ProfilesModule,
    NotificationsModule,
    CollaborationModule,
    InquiriesModule,
    ClientInvitesModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationIdMiddleware).forRoutes('*');
  }
}
