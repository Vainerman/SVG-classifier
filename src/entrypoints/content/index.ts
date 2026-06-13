/**
 * Content-script entrypoint. Thin: instantiates the orchestrator. All logic
 * lives in src/content/* so it stays unit-testable and free of WXT globals.
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { Controller } from '@/content/controller';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  async main() {
    const controller = new Controller();
    await controller.start();
  },
});
