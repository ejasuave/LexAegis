/** Single source for the Qwen article: the build/qwen page renders it and submission/qwen-article.md mirrors it. */
export interface ArticleSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export const QWEN_ARTICLE = {
  title: 'How LexAegis uses Qwen 3.8 Max, and what it does not let it do',
  status:
    'Draft. Not yet published: the application is not deployed, and this text describes one synthetic run, not a production service.',
  sections: [
    {
      heading: 'The problem',
      paragraphs: [
        'Before someone signs an employment settlement in England and Wales, an adviser checks it, increasingly with AI help. The risky moment is not reading the document; it is afterwards, when nobody can show exactly what was checked, what the figures were and who approved them. LexAegis is a review workspace built on Proof of Review, a small protocol in which a person approves an exact package and anyone can verify the same package later without trusting our application.',
        'Qwen 3.8 Max has one job in that workflow: it plans the review and asks for evidence. It does not approve, sign, confirm or write to the chain.',
      ],
    },
    {
      heading: 'What the model does',
      paragraphs: [
        'The assistant calls qwen3.8-max through the provider’s compatible-mode endpoint (Singapore region) with JSON-schema output and native tool calls. The model can request exactly four read-only tools: read_sources, check_payments, check_evidence and get_status. Each request is a model decision; each execution is ordinary code that validates the arguments, runs under a budget and returns a typed result. A run is bounded by a wall-clock limit, a number of provider attempts and a number of tool executions.',
        'The tools cannot approve, sign, send or change a rule. Arithmetic is not left to the model either: check_payments is deterministic code that works in GBP pence as decimal strings.',
      ],
    },
    {
      heading: 'One synthetic example',
      paragraphs: [
        'The fixture is a fictional agreement (Northwind Demo Ltd and A. Example) stating a total of £24,000 with instalments of £10,000 and £12,000. In the recorded run the model requested the tools in order. read_sources returned four source handles. check_payments, executed by code, reported a mismatch: stated total 2,400,000 pence, instalments summing to 2,200,000, a difference of 200,000 pence (£2,000). check_evidence reported six evidence gaps, such as no linked proof of independent advice. get_status reported the current chain status.',
        'The final answer cited four validated blocks. Every citation had to resolve to a source handle the tools had actually returned; an answer that cited something else would have been rejected rather than shown. The answer also stated two limitations and left one item for the user to resolve. The £14,000 what-if shown beside it is labelled SIMULATED until a genuinely corrected document is imported and reviewed.',
      ],
    },
    {
      heading: 'What was measured',
      paragraphs: [
        'The recorded smoke run used prompt manifest version 1 and tool schemas at version 1 (their SHA-256 values are in the evidence file), a returned model name equal to the requested name, and six provider request identifiers. Provider-reported token usage was not captured in that file, so we make no token or cost claim. A second run was cancelled mid-flight: the run ended with a cancelled terminal event after one provider attempt and no tool executions. Cancellation does not retract text already sent, and a request already submitted may still be billed.',
      ],
    },
    {
      heading: 'What stays outside the model',
      paragraphs: [
        'Source bindings, arithmetic, vault keys and receipt verification are controlled by code. The approval is a trusted click by a person on an exact frozen package; no model, chat message or voice input can approve, sign or confirm. Technical failures cannot be waived. The registry on Monad Testnet records only a commitment, and the independent verifier checks a package against a reference you obtained separately.',
        'Model output is not deterministic, and nothing here is zero-knowledge: the selected document text is sent to the model provider, whose retention and training settings this application does not know.',
      ],
    },
    {
      heading: 'Limits of the evidence',
      paragraphs: [
        'This is one run and one cancellation on one synthetic fixture. It shows that the tool loop, schema validation and citation checks work against the real model; it does not show reliability, legal correctness or real users. The hosted application, real-device passkey ceremonies and a published deployment are not done yet. A receipt proves that an account committed to an exact package, not that the agreement is lawful or that anyone was qualified.',
        'Sources: the compatible-mode Chat Completions reference of the Qwen provider for the request and tool-call format; our own evidence file docs/evidence/chapter09-qwen-smoke-2026-10-12.json for every figure above.',
      ],
    },
  ],
} as const satisfies {
  title: string;
  status: string;
  sections: readonly ArticleSection[];
};
