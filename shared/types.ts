import { z } from 'zod';

export const createDocSchema = z.object({
  title: z.string().trim().min(1).max(120).default('Untitled'),
});

export const renameDocSchema = z.object({
  title: z.string().trim().min(1).max(120),
});

export const createVersionSchema = z.object({
  name: z.string().trim().min(1).max(80),
});

export interface DocSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface Version {
  id: number;
  name: string;
  createdAt: number;
  /** First characters of the text at that version, for the history list. */
  preview: string;
  characters: number;
}

/** The shared Y.Text every client binds its editor to. */
export const TEXT_KEY = 'content';
