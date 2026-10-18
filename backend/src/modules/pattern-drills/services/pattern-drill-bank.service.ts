import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import { BankItem, PatternId } from '../types/pattern-drill.types';

@Injectable()
export class PatternDrillBankService implements OnModuleInit {
  private items: BankItem[] | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    await this.reload();
  }

  async reload(): Promise<void> {
    const bankPath =
      this.config.get<string>('patternDrill.bankPath') ?? './pattern-drills/bank.yaml';
    const raw = await fs.readFile(path.resolve(bankPath), 'utf-8');
    this.items = yaml.load(raw) as BankItem[];
  }

  all(): BankItem[] {
    if (!this.items) {
      throw new Error('PatternDrillBankService: bank not loaded — reload() must run first');
    }
    return this.items;
  }

  byPattern(pattern: PatternId): BankItem[] {
    return this.all().filter((item) => item.pattern === pattern);
  }
}
