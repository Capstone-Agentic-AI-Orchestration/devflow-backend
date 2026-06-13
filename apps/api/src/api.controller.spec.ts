import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { ApiController } from './api.controller';
import { ApiService } from './api.service';

describe('ApiController', () => {
  let controller: ApiController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ApiController],
      providers: [ApiService],
    }).compile();

    controller = module.get<ApiController>(ApiController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('getServiceInfo returns devflow-backend identity', () => {
    const result = controller.getServiceInfo();
    expect(result.service).toBe('devflow-backend');
    expect(result.version).toBe('1.0.0');
  });

  it('getServiceInfo returns a well-formed ServiceInfo object', () => {
    const result = controller.getServiceInfo();
    expect(result).toEqual({ service: 'devflow-backend', version: '1.0.0' });
  });
});
