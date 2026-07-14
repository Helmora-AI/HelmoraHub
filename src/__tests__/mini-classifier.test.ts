import { describe, expect, it } from 'vitest';
import {
  classifyMiniIntent,
  type MiniClassifierInput,
  type MiniRole,
} from '../services/mini-classifier.js';

function classify(input: MiniClassifierInput): MiniRole {
  return classifyMiniIntent(input).role;
}

describe('classifyMiniIntent', () => {
  it.each([
    ['general', 'Chào bạn, hôm nay thế nào?'],
    ['reasoning', 'Phân tích từng bước và chứng minh kết luận này.'],
    ['coding', 'Please implement and refactor this TypeScript function.'],
    ['research', 'Nghiên cứu, tìm nguồn và tổng hợp tài liệu về chủ đề này.'],
    ['creative', 'Lên ý tưởng và đặt tên cho một chiến dịch mới.'],
    ['review', 'Audit this proposal and critique its correctness.'],
  ] satisfies Array<[MiniRole, string]>)('selects %s deterministically', (role, latestUserText) => {
    expect(classify({ latestUserText })).toBe(role);
  });

  it.each([
    ['coding', 'viet code va trien khai ham nay'],
    ['research', 'nghien cuu va tim nguon kiem chung'],
    ['reasoning', 'phan tich va suy luan tung buoc'],
    ['creative', 'len y tuong va dat ten san pham'],
    ['review', 'danh gia va kiem tra lo hong'],
  ] satisfies Array<[MiniRole, string]>)('supports unaccented Vietnamese for %s', (role, latestUserText) => {
    expect(classify({ latestUserText })).toBe(role);
  });

  it('uses fixed tie precedence among roles above the threshold', () => {
    const result = classifyMiniIntent({
      latestUserText: 'Review this React code for security vulnerabilities and fix the implementation.',
    });

    expect(result.scores.review).toBeGreaterThanOrEqual(result.scores.coding);
    expect(result.role).toBe('review');
  });

  it('does not route on a weak ambiguous signal', () => {
    expect(classify({ latestUserText: 'Can you check this?' })).toBe('general');
  });

  it('lets a new specialist intent override continuation context', () => {
    expect(classify({
      latestUserText: 'Now research this topic and cite reliable sources.',
      previousMiniRole: 'coding',
      previousUserText: 'Implement the TypeScript function.',
    })).toBe('research');
  });

  it('retains a trusted previous Mini role for an explicit continuation', () => {
    expect(classify({
      latestUserText: 'Tiếp tục đi.',
      previousMiniRole: 'coding',
      previousUserText: 'Nghiên cứu và tìm nguồn cho chủ đề này.',
    })).toBe('coding');
  });

  it('uses previous user intent at reduced weight when no previous role exists', () => {
    expect(classify({
      latestUserText: 'Do that.',
      previousUserText: 'Please audit this code for security vulnerabilities.',
    })).toBe('review');
  });

  it('returns general for a continuation without trusted user context', () => {
    expect(classify({ latestUserText: 'Đoạn trên nhé.' })).toBe('general');
  });

  it('ignores previous text unless the latest message is a continuation', () => {
    expect(classify({
      latestUserText: 'Cảm ơn bạn.',
      previousUserText: 'Implement and debug this TypeScript code.',
      previousMiniRole: 'coding',
    })).toBe('general');
  });

  it('returns a complete score map and matched signals', () => {
    const result = classifyMiniIntent({ latestUserText: 'Viết code và debug lỗi TypeScript này.' });

    expect(Object.keys(result.scores)).toEqual([
      'reasoning',
      'coding',
      'research',
      'creative',
      'review',
    ]);
    expect(result.matchedSignals.length).toBeGreaterThan(0);
  });
});
