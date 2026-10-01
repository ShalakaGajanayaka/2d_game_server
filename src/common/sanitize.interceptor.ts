import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

export function sanitizeValue(data: any): any {
  if (typeof data === 'string') {
    return data
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/[<>]/g, '')
      .trim();
  }
  if (Array.isArray(data)) {
    return data.map(sanitizeValue);
  }
  if (data !== null && typeof data === 'object') {
    const cleaned: Record<string, any> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }
      cleaned[key] = sanitizeValue(value);
    }
    return cleaned;
  }
  return data;
}

@Injectable()
export class SanitizeInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    if (req && req.body && typeof req.body === 'object') {
      req.body = sanitizeValue(req.body);
    }
    return next.handle();
  }
}
