import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('live')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async readiness(): Promise<{ status: 'ok'; dependencies: { database: 'ok' } }> {
    try {
      await this.prisma.$queryRaw(Prisma.sql`SELECT 1`);
      return { status: 'ok', dependencies: { database: 'ok' } };
    } catch {
      throw new ServiceUnavailableException({
        title: 'Service Unavailable',
        detail: 'Database readiness check failed',
      });
    }
  }
}
