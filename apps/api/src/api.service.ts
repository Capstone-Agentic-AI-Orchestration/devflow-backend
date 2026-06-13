import { Injectable } from '@nestjs/common';

export interface ServiceInfo {
  service: string;
  version: string;
}

@Injectable()
export class ApiService {
  getServiceInfo(): ServiceInfo {
    return { service: 'devflow-backend', version: '1.0.0' };
  }
}
