import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { JsonContentTypeInterceptor } from './json-content-type.interceptor.js';
import { ProblemDetailsFilter } from './problem-details.filter.js';
import { validationPipe } from './validation.js';

@Module({
  providers: [
    { provide: APP_FILTER, useClass: ProblemDetailsFilter },
    { provide: APP_PIPE, useValue: validationPipe },
    { provide: APP_INTERCEPTOR, useClass: JsonContentTypeInterceptor },
  ],
})
export class CommonModule {}
