package golden;

import java.io.IOException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.example.einvoice.billing.DocumentEnvelope;
import com.example.einvoice.notes.CreditNoteContent;
import com.example.einvoice.notes.CreditNoteKind;
import com.example.einvoice.notes.CreditNoteXmlBuilder;
import com.example.einvoice.notes.DebitNoteContent;
import com.example.einvoice.notes.DebitNoteKind;
import com.example.einvoice.notes.DebitNoteXmlBuilder;
import com.example.einvoice.notes.NoteTax;
import com.example.einvoice.sequence.AccessKeyParts;
import com.example.einvoice.xml.DocumentType;
import com.example.einvoice.xml.InvoiceXmlBuilder;
import com.example.einvoice.xml.InvoiceXmlData;
import com.example.einvoice.xml.InvoiceXmlFixtures;

/**
 * XML de factura, nota de crédito y nota de débito con los generadores de la API Java, y el JSON del contenido de
 * las notas ({@code CreditNoteKind} y {@code DebitNoteKind} con un repositorio nulo). Cada caso guarda sus datos de
 * entrada (decimales como cadenas planas con su escala, fechas ISO), la ruta del XML y {@code contentJson}.
 */
final class DocumentCases {

	private static final LocalDate ISSUE = LocalDate.of(2026, 10, 19);

	private static final LocalDate MODIFIED_ISSUE = LocalDate.of(2026, 10, 1);

	private static final UUID INVOICE_ID = UUID.fromString("5d0f3a52-8c1e-4b63-9a7d-2e4f6a1b9c30");

	private static final UUID PRODUCT_1 = UUID.fromString("0b9e6c1a-3d47-4f2e-8a15-7c3d9e0f2b64");

	private static final UUID PRODUCT_2 = UUID.fromString("c4a81f77-92de-4a0b-b3c6-15e8d70a49f2");

	private static final CreditNoteKind CREDIT = new CreditNoteKind(null);

	private static final DebitNoteKind DEBIT = new DebitNoteKind(null);

	private DocumentCases() {
	}

	static void generate(Path out) throws IOException {
		Path xmlDir = out.resolve("documents");
		Files.createDirectories(xmlDir);
		List<Object> cases = new ArrayList<>();

		for (Map.Entry<String, InvoiceXmlData> invoice : invoices().entrySet()) {
			byte[] xml = InvoiceXmlBuilder.build(invoice.getValue());
			Map<String, Object> entry = caseHeader(invoice.getKey(), "01");
			entry.put("data", invoiceData(invoice.getValue()));
			finish(xmlDir, entry, invoice.getKey(), xml, null);
			cases.add(entry);
		}
		for (Map.Entry<String, Object[]> note : creditNotes().entrySet()) {
			DocumentEnvelope envelope = (DocumentEnvelope) note.getValue()[0];
			CreditNoteContent content = (CreditNoteContent) note.getValue()[1];
			boolean xml = (boolean) note.getValue()[2];
			Map<String, Object> entry = caseHeader(note.getKey(), "04");
			entry.put("data", noteData(envelope, creditContent(content)));
			finish(xmlDir, entry, note.getKey(), xml ? CreditNoteXmlBuilder.build(envelope, content) : null,
					CREDIT.contentJson(content));
			cases.add(entry);
		}
		for (Map.Entry<String, Object[]> note : debitNotes().entrySet()) {
			DocumentEnvelope envelope = (DocumentEnvelope) note.getValue()[0];
			DebitNoteContent content = (DebitNoteContent) note.getValue()[1];
			Map<String, Object> entry = caseHeader(note.getKey(), "05");
			entry.put("data", noteData(envelope, debitContent(content)));
			finish(xmlDir, entry, note.getKey(), DebitNoteXmlBuilder.build(envelope, content),
					DEBIT.contentJson(content));
			cases.add(entry);
		}

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("cases", cases);
		GoldenGenerator.write(out.resolve("documents.json"), root);
	}

	// ---------------------------------------------------------------- facturas

	private static Map<String, InvoiceXmlData> invoices() {
		Map<String, InvoiceXmlData> cases = new LinkedHashMap<>();
		cases.put("factura-estandar", InvoiceXmlFixtures.standard());

		InvoiceXmlFixtures.Builder provider = InvoiceXmlFixtures.builder();
		provider.providerRuc = "1790012345001";
		cases.put("factura-con-ruc-proveedor", provider.build());

		InvoiceXmlFixtures.Builder emprendedor = InvoiceXmlFixtures.builder();
		emprendedor.rimpeRegime = "EMPRENDEDOR";
		cases.put("factura-rimpe-emprendedor", emprendedor.build());

		InvoiceXmlFixtures.Builder popular = InvoiceXmlFixtures.builder();
		popular.rimpeRegime = "NEGOCIO_POPULAR";
		cases.put("factura-negocio-popular", popular.build());

		InvoiceXmlFixtures.Builder fiscal = InvoiceXmlFixtures.builder();
		fiscal.withholdingAgentCode = "1";
		fiscal.specialTaxpayerCode = "5368";
		fiscal.accountingRequired = true;
		cases.put("factura-agente-retencion-contribuyente-especial", fiscal.build());

		InvoiceXmlFixtures.Builder special = InvoiceXmlFixtures.builder();
		special.legalName = "Ñandú & Hijos <\"S.A.\"> 'O'Brien' ñ é 😀";
		special.lines = new ArrayList<>(List.of(
				new InvoiceXmlData.Line("SRV-001", "Café & té <frío> \"doble\" 'simple' 😀",
						InvoiceXmlFixtures.d("2"), InvoiceXmlFixtures.d("10.00"), InvoiceXmlFixtures.d("0.00"),
						InvoiceXmlFixtures.d("20.00"), "2", "4", InvoiceXmlFixtures.d("15.00"),
						InvoiceXmlFixtures.d("3.00")),
				special.lines.get(1)));
		cases.put("factura-caracteres-especiales", special.build());

		InvoiceXmlFixtures.Builder term = InvoiceXmlFixtures.builder();
		term.payments = List.of(
				new InvoiceXmlData.Payment("20", InvoiceXmlFixtures.d("30.00"), InvoiceXmlFixtures.d("30"), "dias"),
				new InvoiceXmlData.Payment("01", InvoiceXmlFixtures.d("7.00"), null, null));
		cases.put("factura-pago-con-plazo", term.build());

		InvoiceXmlFixtures.Builder bare = InvoiceXmlFixtures.builder();
		bare.tradeName = null;
		bare.establishmentAddress = null;
		bare.customerAddress = " ";
		cases.put("factura-sin-opcionales", bare.build());

		// Escalas mayores que las del XML: cantidad y precio a 6 decimales, el resto a 2, mitad hacia arriba.
		InvoiceXmlFixtures.Builder rounding = InvoiceXmlFixtures.builder();
		rounding.lines = new ArrayList<>(List.of(
				new InvoiceXmlData.Line("RED-001", "Redondeo", InvoiceXmlFixtures.d("1.2345675"),
						InvoiceXmlFixtures.d("0.0000005"), InvoiceXmlFixtures.d("0.005"),
						InvoiceXmlFixtures.d("20.005"), "2", "2", InvoiceXmlFixtures.d("12"),
						InvoiceXmlFixtures.d("2.4005")),
				rounding.lines.get(1)));
		cases.put("factura-redondeo-de-escalas", rounding.build());
		return cases;
	}

	// ----------------------------------------------------------- notas de crédito

	private static Map<String, Object[]> creditNotes() {
		Map<String, Object[]> cases = new LinkedHashMap<>();
		DocumentEnvelope onInvoice = envelope(DocumentType.CREDIT_NOTE, "04", null, "NONE", null, null, false,
				new DocumentEnvelope.Totals(d("34.00"), d("0.00"), d("3.00"), d("37.00")), INVOICE_ID);
		cases.put("nota-credito-sobre-factura", new Object[] { onInvoice,
				creditNote("Devolución de mercadería", 1, PRODUCT_1, 2, PRODUCT_2, "0.00", "0.00"), true });

		DocumentEnvelope manual = envelope(DocumentType.CREDIT_NOTE, "04", "1790099999001", "EMPRENDEDOR", "1",
				"5368", true, new DocumentEnvelope.Totals(d("34.00"), d("0"), d("3.00"), d("37.00")), null);
		cases.put("nota-credito-a-mano", new Object[] { manual,
				creditNote("Cambio & <ajuste>", null, null, null, null, "0", "0"), true });

		// Solo el JSON: los controles que XML no admite se guardan en el contenido, que el XML rechaza.
		cases.put("nota-credito-json-con-controles", new Object[] { onInvoice,
				creditNote("Tab\t, salto\n, comillas \" y barra \\, \u0001 \u001f \u007f é 😀", 1,
						PRODUCT_1, null, null, "0.00", "0.00"), false });
		return cases;
	}

	private static CreditNoteContent creditNote(String reason, Integer firstNo, UUID firstProduct, Integer secondNo,
			UUID secondProduct, String firstDiscount, String secondDiscount) {
		return new CreditNoteContent(reason, List.of(
				new CreditNoteContent.Line(firstNo, firstProduct, "SRV-001", "Servicio de consultoría", d("2"),
						d("10.00"), d(firstDiscount), d("20.00"), "2", "4", d("15.00"), d("3.00")),
				new CreditNoteContent.Line(secondNo, secondProduct, "LIB-001", "Libro", d("1.5"), d("9.333333"),
						d(secondDiscount), d("14.00"), "2", "0", d("0.00"), d("0.00"))),
				List.of(new NoteTax("2", "0", d("0.00"), d("14.00"), d("0.00")),
						new NoteTax("2", "4", d("15.00"), d("20.00"), d("3.00"))));
	}

	// ------------------------------------------------------------ notas de débito

	private static Map<String, Object[]> debitNotes() {
		Map<String, Object[]> cases = new LinkedHashMap<>();
		DocumentEnvelope envelope = envelope(DocumentType.DEBIT_NOTE, "05", "1790099999001", "NEGOCIO_POPULAR", null,
				null, false, new DocumentEnvelope.Totals(d("15.00"), d("0.00"), d("1.50"), d("16.50")), INVOICE_ID);
		cases.put("nota-debito-dos-tarifas", new Object[] { envelope, debitNote(null, null) });
		cases.put("nota-debito-con-plazo", new Object[] { envelope, debitNote(d("2"), "meses") });
		return cases;
	}

	private static DebitNoteContent debitNote(BigDecimal term, String timeUnit) {
		return new DebitNoteContent(
				List.of(new DebitNoteContent.Reason("Intereses de mora & <gastos>", d("10.00"), "2", "4", d("15.00"),
						d("1.50")),
						new DebitNoteContent.Reason("Gastos de cobranza", d("5.00"), "2", "0", d("0.00"), d("0.00"))),
				List.of(new NoteTax("2", "0", d("0.00"), d("5.00"), d("0.00")),
						new NoteTax("2", "4", d("15.00"), d("10.00"), d("1.50"))),
				List.of(new DebitNoteContent.Payment("01", d("16.50"), term, timeUnit)));
	}

	// ------------------------------------------------------------------- sobre

	private static DocumentEnvelope envelope(DocumentType type, String code, String providerRuc, String rimpe,
			String withholding, String special, boolean accounting, DocumentEnvelope.Totals totals, UUID modifiedId) {
		String accessKey = new AccessKeyParts(ISSUE, code, "1790012345001", "1", "001", "002", 7, "12345678", "1")
			.toAccessKey();
		return new DocumentEnvelope(type, "1",
				new DocumentEnvelope.Issuer("Comercial Andina S.A.", "Andina", "1790012345001",
						"Av. Amazonas N34-12, Quito", "Av. 10 de Agosto, Quito", accounting, special, withholding,
						rimpe, "022345678"),
				accessKey, "001", "002", 7, ISSUE,
				new DocumentEnvelope.Recipient("05", "1712345678", "María Pérez", "Av. República, Quito",
						"maria@example.com", null),
				totals,
				new DocumentEnvelope.ModifiedDocument(modifiedId, "01", "001-001-000000123", MODIFIED_ISSUE),
				providerRuc);
	}

	private static BigDecimal d(String value) {
		return new BigDecimal(value);
	}

	// ------------------------------------------------------- representación JSON

	private static Map<String, Object> caseHeader(String name, String type) {
		Map<String, Object> entry = new LinkedHashMap<>();
		entry.put("name", name);
		entry.put("type", type);
		return entry;
	}

	private static void finish(Path xmlDir, Map<String, Object> entry, String name, byte[] xml, String contentJson)
			throws IOException {
		if (xml == null) {
			entry.put("xml", null);
		}
		else {
			Files.write(xmlDir.resolve(name + ".xml"), xml);
			entry.put("xml", "documents/" + name + ".xml");
		}
		entry.put("contentJson", contentJson);
	}

	private static String text(BigDecimal value) {
		return value == null ? null : value.toPlainString();
	}

	private static Map<String, Object> invoiceData(InvoiceXmlData d) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("environment", d.environment());
		m.put("issuerLegalName", d.issuerLegalName());
		m.put("issuerTradeName", d.issuerTradeName());
		m.put("issuerRuc", d.issuerRuc());
		m.put("accessKey", d.accessKey());
		m.put("documentType", d.documentType());
		m.put("establishmentCode", d.establishmentCode());
		m.put("emissionPointCode", d.emissionPointCode());
		m.put("sequence", d.sequence());
		m.put("headOfficeAddress", d.headOfficeAddress());
		m.put("withholdingAgentCode", d.withholdingAgentCode());
		m.put("rimpeRegime", d.rimpeRegime());
		m.put("issueDate", d.issueDate().toString());
		m.put("establishmentAddress", d.establishmentAddress());
		m.put("specialTaxpayerCode", d.specialTaxpayerCode());
		m.put("accountingRequired", d.accountingRequired());
		m.put("customerIdType", d.customerIdType());
		m.put("customerName", d.customerName());
		m.put("customerIdNumber", d.customerIdNumber());
		m.put("customerAddress", d.customerAddress());
		m.put("subtotal", text(d.subtotal()));
		m.put("totalDiscount", text(d.totalDiscount()));
		List<Object> taxes = new ArrayList<>();
		for (InvoiceXmlData.Tax tax : d.taxes()) {
			taxes.add(tax(tax.taxCode(), tax.rateCode(), tax.rate(), tax.base(), tax.amount()));
		}
		m.put("taxes", taxes);
		m.put("total", text(d.total()));
		List<Object> lines = new ArrayList<>();
		for (InvoiceXmlData.Line line : d.lines()) {
			Map<String, Object> l = new LinkedHashMap<>();
			l.put("mainCode", line.mainCode());
			l.put("description", line.description());
			l.put("quantity", text(line.quantity()));
			l.put("unitPrice", text(line.unitPrice()));
			l.put("discount", text(line.discount()));
			l.put("subtotal", text(line.subtotal()));
			l.put("taxCode", line.taxCode());
			l.put("taxRateCode", line.taxRateCode());
			l.put("taxRate", text(line.taxRate()));
			l.put("taxAmount", text(line.taxAmount()));
			lines.add(l);
		}
		m.put("lines", lines);
		List<Object> payments = new ArrayList<>();
		for (InvoiceXmlData.Payment payment : d.payments()) {
			payments.add(payment(payment.methodCode(), payment.amount(), payment.term(), payment.timeUnit()));
		}
		m.put("payments", payments);
		m.put("providerRuc", d.providerRuc());
		return m;
	}

	private static Map<String, Object> tax(String taxCode, String rateCode, BigDecimal rate, BigDecimal base,
			BigDecimal amount) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("taxCode", taxCode);
		m.put("rateCode", rateCode);
		m.put("rate", text(rate));
		m.put("base", text(base));
		m.put("amount", text(amount));
		return m;
	}

	private static Map<String, Object> payment(String methodCode, BigDecimal amount, BigDecimal term,
			String timeUnit) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("methodCode", methodCode);
		m.put("amount", text(amount));
		m.put("term", text(term));
		m.put("timeUnit", timeUnit);
		return m;
	}

	private static Map<String, Object> noteData(DocumentEnvelope e, Map<String, Object> content) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("envelope", envelopeData(e));
		m.put("content", content);
		return m;
	}

	private static Map<String, Object> envelopeData(DocumentEnvelope e) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("type", e.type().code());
		m.put("environment", e.environment());
		DocumentEnvelope.Issuer issuer = e.issuer();
		Map<String, Object> i = new LinkedHashMap<>();
		i.put("legalName", issuer.legalName());
		i.put("tradeName", issuer.tradeName());
		i.put("ruc", issuer.ruc());
		i.put("headOfficeAddress", issuer.headOfficeAddress());
		i.put("establishmentAddress", issuer.establishmentAddress());
		i.put("accountingRequired", issuer.accountingRequired());
		i.put("specialTaxpayerCode", issuer.specialTaxpayerCode());
		i.put("withholdingAgentCode", issuer.withholdingAgentCode());
		i.put("rimpeRegime", issuer.rimpeRegime());
		i.put("phone", issuer.phone());
		m.put("issuer", i);
		m.put("accessKey", e.accessKey());
		m.put("establishmentCode", e.establishmentCode());
		m.put("emissionPointCode", e.emissionPointCode());
		m.put("sequence", e.sequence());
		m.put("issueDate", e.issueDate().toString());
		DocumentEnvelope.Recipient recipient = e.recipient();
		Map<String, Object> r = new LinkedHashMap<>();
		r.put("idType", recipient.idType());
		r.put("idNumber", recipient.idNumber());
		r.put("name", recipient.name());
		r.put("address", recipient.address());
		r.put("email", recipient.email());
		r.put("phone", recipient.phone());
		m.put("recipient", r);
		DocumentEnvelope.Totals totals = e.totals();
		Map<String, Object> t = new LinkedHashMap<>();
		t.put("subtotal", text(totals.subtotal()));
		t.put("totalDiscount", text(totals.totalDiscount()));
		t.put("totalTax", text(totals.totalTax()));
		t.put("total", text(totals.total()));
		m.put("totals", t);
		DocumentEnvelope.ModifiedDocument modified = e.modified();
		Map<String, Object> mod = new LinkedHashMap<>();
		mod.put("documentId", modified.documentId() == null ? null : modified.documentId().toString());
		mod.put("code", modified.code());
		mod.put("number", modified.number());
		mod.put("issueDate", modified.issueDate().toString());
		m.put("modified", mod);
		m.put("providerRuc", e.providerRuc());
		return m;
	}

	private static Map<String, Object> creditContent(CreditNoteContent c) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("reason", c.reason());
		List<Object> lines = new ArrayList<>();
		for (CreditNoteContent.Line line : c.lines()) {
			Map<String, Object> l = new LinkedHashMap<>();
			l.put("invoiceLineNo", line.invoiceLineNo());
			l.put("productId", line.productId() == null ? null : line.productId().toString());
			l.put("mainCode", line.mainCode());
			l.put("description", line.description());
			l.put("quantity", text(line.quantity()));
			l.put("unitPrice", text(line.unitPrice()));
			l.put("discount", text(line.discount()));
			l.put("subtotal", text(line.subtotal()));
			l.put("taxCode", line.taxCode());
			l.put("taxRateCode", line.taxRateCode());
			l.put("taxRate", text(line.taxRate()));
			l.put("taxAmount", text(line.taxAmount()));
			lines.add(l);
		}
		m.put("lines", lines);
		m.put("taxes", noteTaxes(c.taxes()));
		return m;
	}

	private static Map<String, Object> debitContent(DebitNoteContent c) {
		Map<String, Object> m = new LinkedHashMap<>();
		List<Object> reasons = new ArrayList<>();
		for (DebitNoteContent.Reason reason : c.reasons()) {
			Map<String, Object> r = new LinkedHashMap<>();
			r.put("reason", reason.reason());
			r.put("value", text(reason.value()));
			r.put("taxCode", reason.taxCode());
			r.put("taxRateCode", reason.taxRateCode());
			r.put("taxRate", text(reason.taxRate()));
			r.put("taxAmount", text(reason.taxAmount()));
			reasons.add(r);
		}
		m.put("reasons", reasons);
		m.put("taxes", noteTaxes(c.taxes()));
		List<Object> payments = new ArrayList<>();
		for (DebitNoteContent.Payment payment : c.payments()) {
			payments.add(payment(payment.methodCode(), payment.amount(), payment.term(), payment.timeUnit()));
		}
		m.put("payments", payments);
		return m;
	}

	private static List<Object> noteTaxes(List<NoteTax> taxes) {
		List<Object> list = new ArrayList<>();
		for (NoteTax tax : taxes) {
			list.add(tax(tax.taxCode(), tax.rateCode(), tax.rate(), tax.base(), tax.amount()));
		}
		return list;
	}

}
