# BASHT × Daftra — Read Access Repair V2 (تقرير مختصر)

**الأساس:** `a3890c0` (PR #9). **الوضع:** قراءة فقط — لا POST/PUT/DELETE جديد، `DAFTRA_WRITES_ENABLED` لم يُمسّ، لا تغيير في مفاتيح API أو Railway أو الصلاحيات.
**المصدر:** وثائق Daftra الرسمية (`docs.daftara.dev`، فهرس `llms.txt` وصفحات كل endpoint). لم يكن لدى الجلسة وصول إلى حساب Daftra الحيّ، لذلك لم يُعاد إنتاج الأعطال على الحساب نفسه؛ كل إصلاح أدناه مبني على نص وثيقة محدد، وما لا يمكن إثباته بالوثائق مذكور كـ«يحتاج تحققًا حيًّا».

## 1. ما تم إصلاحه (مُثبت بالوثائق + اختبارات)

| # | البند | السبب الموثّق | الإصلاح |
| --- | --- | --- | --- |
| 1 | القيود اليومية / دليل الحسابات | `/journals`, `/journal_accounts`, `/journal_cats` موجودة رسميًا لكنها لم تكن في قائمة السماح (`journal_entries` اسم غير موجود في الوثائق؛ المورد `journals`) | أُضيفت `journals` (سقف limit = 100) و`journal_accounts` و`journal_cats` و`incomes` (قائمة + سجل واحد، GET فقط). أي مسار غير موثّق (`journal_entries`, `deposits`, `advances`, `expense_categories`, `bank_accounts`…) يبقى مرفوضًا |
| 2 | التقارير 404 | الوثيقة: «404 = التقرير غير مكشوف على هذا النشر (allow-list لكل نشر)»؛ **403** وحده يعني نقص صلاحية | تصنيف الأخطاء: `report_not_exposed` (404) ≠ `forbidden` (403) ≠ `validation` (400) ≠ `transient` (502/503/504) ≠ `upstream_error` (500). تُعرض `category` و`hint` و`owner_action` و`validation_errors` الخاصة بـ Daftra |
| 3 | معاملات التقارير (`ledger`, `trial_balance`, `income_statement`, `balance_sheet`, …) | قيم مثل `cost_center_id=-1` و`branch_id=all|-1` و`journals_branch_id=all` مرفوضة محليًا رغم أنها موثّقة؛ `ledger` يتطلب تاريخًا؛ `date_selector` لا يُجمع مع التواريخ | قبول القيم الخاصة الموثّقة فقط، وفحص القواعد المشتركة قبل الإرسال برسالة واضحة، في الوكيل **وفي Broker** بنفس الدالة |
| 4 | `expenses_summary` / `expenses_details` | `group_by` مطلوب وبقيم بحالة أحرف محددة (`Category`, `Monthly`…)؛ التواريخ `from_date/to_date` | توحيد حالة الأحرف إلى الصيغة الموثّقة، تحويل `date_from/date_to` إلى `from_date/to_date`، رفض القيمة الخاطئة مع القائمة المقبولة |
| 5 | `revenue` / `payments` / تقارير المنتجات | `report_type` مطلوب و`group_by` يعتمد عليه (جدول موثّق)؛ `brand` مرفوض والصحيح `brand_id` | تحقق من `report_type` و`group_by` المتوافق، توحيد قيم enum (`is_summary`, `payment_method`…)، تلميح `brand → brand_id` |
| 6 | `product_categories` / كشوف العملاء: `Invalid page` | Daftra يرفض طلب الترقيم نفسه برسالة «Invalid page»؛ وعلى جانبنا كانت صفحة فارغة تُبلّغ `page: 0` تُرفض كخطأ | `invalid_page` تصنيف مستقل (ليس صلاحية)؛ عند فشل الصفحة الأولى يُعاد الطلب مرة واحدة بدون `limit/page` مع إثبات الاكتمال من البيانات الوصفية؛ المجموعة الفارغة تُقبل كمكتملة |
| 7 | خزينة فردية 502 | Broker كان يحوّل أي 5xx (حتى 500 من Daftra) إلى 502 بلا تمييز | يمرّر الآن `upstream_status`؛ وعند فشل `get treasuries/<id>` (و`product_categories`, `journal_cats`, `journal_accounts`) من جهة الخادم تُقرأ **القائمة الكاملة المُثبتة الاكتمال** ويُرجَع السجل مع `"source":"list_fallback"`؛ لا يُخترع سجل غائب (404) |
| 8 | الحسابات البنكية | لا endpoint مستقل. `treasuries` تشمل الحسابات البنكية (`type=1` بنك، `3` خزينة) | موثّق في `capabilities` وSKILL؛ القراءة عبر `treasuries` |
| 9 | الصلاحيات | أسماء كيانات Roles غير منشورة في الوثائق (الأمثلة: `invoice`, `client`, `supplier`, `purchase_invoice`) | أمر جديد **`access-report`**: GET واحد صغير لكل endpoint/تقرير مسموح مع تصنيف النتيجة وإجراء المالك — لا يغيّر أي دور أو مفتاح |

## 2. ما بقي غير متاح (لا يوجد endpoint موثّق)

- **تصنيفات المصروفات كمورد مستقل** — لا يوجد. البديل: `report expenses_summary --param group_by=Category` أو `expense_category_id` في `expenses`.
- **كشف حساب رسمي لعميل/مورد** — لا يوجد في الوثائق. `statement` يبقى محسوبًا محليًا ومُعلَّمًا `official:false` (وأُضيف `official_statement.available=false`). الدفاتر الرسمية: `report ledger` / `trial_balance`.
- **`deposits`** — لا مورد بهذا الاسم؛ استخدم `journals` / `report ledger` / `treasuries`. **`advances`** = فواتير type 19 (`list invoices --query type=19`) و`report advance_payments`. **`journal_entries`** = `journals`.
- **Cost centers** — موثّق بمسار `list/1` بقواعد فلترة مختلفة؛ لم يُضف (لا نخمّن).

## 3. ما يحتاج إجراءً من مالك الحساب

1. شغّل بعد النشر: `node skills/basht-daftra/scripts/daftra-cli.mjs access-report` (وكيل الخدمة) وأرسل الناتج — يحدد بدقة أي تقارير هي `forbidden` وأيها `report_not_exposed`.
2. **403 على تقارير المحاسبة/المصروفات** (حسب الوثيقة أربعة أسباب لا يمكن التمييز بينها): تفعيل Accounting plugin، منح مستخدم المفتاح «View all journals» / «View all expenses» / «View own reports»، و**تفعيل المفتاح للوصول الآلي (machine access)** للتقارير. لا توسّع Role المفتاح أبعد من اللازم.
3. **403 على `journals`/`journal_accounts`/`journal_cats`/`incomes`/`treasuries`:** راجع Roles في (Settings → API → API Key): إن كانت «Only Allow» أضف هذه الكيانات فقط، وإن كانت «Only Block» أزلها من القائمة. أسماء الكيانات المقبولة داخل Roles غير منشورة — تحقق من واجهة Daftra، لا من التخمين.
4. **404 على تقرير:** لا إجراء على المفتاح؛ التقرير غير مكشوف على نشر الحساب — اسأل دعم Daftra إن كان مطلوبًا.

## 4. تحقق مطلوب على الحساب الحيّ بعد النشر (لم يمكن هنا)

- سبب `Invalid page` في `product_categories` وكشوف العملاء لم يُعاد إنتاجه؛ الإصلاح دفاعي ويصنّف الفشل بدل إخفائه. إن بقي، سيظهر الآن كـ`invalid_page` مع النص الحرفي من Daftra.
- سبب 502 للخزينة الفردية (500 عند Daftra أم عطل مؤقت): الحقل `upstream_status` سيحسمه؛ والقراءة تنجح عبر القائمة في الحالتين.

## 5. الاختبارات

`npm test` → **407 ناجح / 0 فاشل** (392 سابقة + 15 جديدة في `daftra-read-repair.test.mjs`)، و`npm run test:packaging` → 10/10. اختبارات قديمة عُدّلت في موضع واحد: قائمة المسارات المرفوضة في `daftra-broker-reads.test.mjs` كانت تتضمن `/api2/journals.json` (أصبح موثّقًا) وأُضيفت بدائلها غير الموثقة.
