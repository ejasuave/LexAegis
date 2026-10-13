import type { Metadata } from 'next';
import { QWEN_ARTICLE } from '@/content/qwen-article';

export const metadata: Metadata = { title: 'Building with Qwen · LexAegis' };

/** Static first-party article. No CMS: the text lives in one typed module. */
export default function QwenArticlePage() {
  return (
    <article className="mx-auto max-w-prose px-4 py-8">
      <h1 className="text-2xl font-semibold">{QWEN_ARTICLE.title}</h1>
      <p className="mt-2 text-[0.875rem] text-lj-secondary">{QWEN_ARTICLE.status}</p>
      {QWEN_ARTICLE.sections.map((section) => (
        <section key={section.heading} className="mt-6">
          <h2 className="text-lg font-semibold">{section.heading}</h2>
          {section.paragraphs.map((text) => (
            <p key={text} className="mt-2 leading-relaxed">
              {text}
            </p>
          ))}
        </section>
      ))}
    </article>
  );
}
