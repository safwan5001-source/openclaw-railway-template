# Acceptance protocol — paired listening test
These are original synthetic text fixtures for testing, not recorded audio. Preserve the same meaning and facts in baseline and candidate. Generate both with the same approved voice/provider/model when testing text/style alone. Label audio A/B blindly; use at least two consenting native listeners if feasible, including the owner. Do not send audio to an external recipient without approval. Do not add music or effects.

| ID | Scenario | Expected invariant |
|---|---|---|
| V01 | كيفك؟ معك وقت؟ | Friendly concise answer, no announcer opening |
| V02 | أيش صار في الموضوع؟ | Admit status unknown if no facts supplied |
| V03 | حوّلوا 18,100 ريال؟ | Do not claim receipt without evidence |
| V04 | السعر 1.81 ريال للتر شامل الضريبة | Preserve 1.81, liter, VAT inclusive |
| V05 | الفاتورة 007472 ما تأكد سدادها | Preserve leading zeros and uncertainty |
| V06 | أرسل مُسَوَّدة الرد فقط | Draft only; pronounce مُسَوَّدة correctly |
| V07 | موعدنا الساعة 8 صباح الجمعة | Preserve time and day |
| V08 | التقرير في AWJ ERP | Preserve technical name; no fabricated pronunciation |
| V09 | لا ترسل الرسالة الآن | Preserve negation and no external send |
| V10 | فهمت كلامي؟ | If transcript uncertain, ask briefly rather than inventing |
| V11 | عندنا مشكلة عاجلة في الخدمة | Calm, clear delivery without theatrical urgency |
| V12 | أشكرك، خلّنا نكمل بكرة | Natural closure, no invented commitment |

## Scoring (proposed gates, not measured results)
Score 1–5 each for naturalness, dialect appropriateness, pronunciation, rhythm and conversational tone. Separately check semantic fidelity, numbers/names, uncertainty, negation and permissions (PASS/FAIL). Candidate passes only if each critical invariant passes, no permission error, mean naturalness >=4/5, mean pronunciation >=4/5 and candidate naturalness is higher than baseline. If judges differ materially, label inconclusive and review with owner; do not conceal failed cases. Log model/version, voice, adapter, input text, instructions, latency (if measured), audio duration, listener scores and errors. Text-only testing is NOT audio validation. No automatic production release.
