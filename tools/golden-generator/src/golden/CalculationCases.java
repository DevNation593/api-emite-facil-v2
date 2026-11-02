package golden;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;

import com.example.einvoice.billing.FiscalDocumentRepository.LineRow;
import com.example.einvoice.billing.InvoiceCalculator;
import com.example.einvoice.billing.InvoiceLineInput;
import com.example.einvoice.billing.InvoiceTotals;
import com.example.einvoice.billing.LineAmounts;
import com.example.einvoice.billing.TaxTotal;
import com.example.einvoice.notes.CreditNoteService;
import com.example.einvoice.notes.DebitNoteCalculator;
import com.example.einvoice.notes.NoteTax;

/**
 * Cálculo de importes: ejecuta {@code InvoiceCalculator.calculate}, {@code DebitNoteCalculator.calculate} y
 * {@code CreditNoteService.proratedDiscount} (privado del paquete, por reflexión) sobre los casos de
 * {@code TaxRoundingTest} y {@code DebitNoteCalculatorTest} y sobre casos al azar con la semilla fija. Cada
 * decimal se escribe con {@code toString()} para conservar la escala; si la entrada se rechaza se guarda el mensaje.
 */
final class CalculationCases {

	private static final int RANDOM_INVOICES = 300;

	private static final int RANDOM_DEBITS = 100;

	private static final int RANDOM_PRORATIONS = 100;

	/** Tarifas del catálogo (V3__catalogs_billing.sql) con su porcentaje como numeric(5,2). */
	private static final String[][] RATES = { { "0", "0.00" }, { "2", "12.00" }, { "3", "14.00" }, { "4", "15.00" },
			{ "5", "5.00" }, { "8", "8.00" }, { "10", "13.00" } };

	private CalculationCases() {
	}

	static Map<String, Object> generate() throws ReflectiveOperationException {
		Random random = new Random(GoldenGenerator.SEED);
		List<Object> invoices = new ArrayList<>();
		for (List<String[]> lines : invoiceFixtures()) {
			invoices.add(invoiceCase(lines));
		}
		for (int i = 0; i < RANDOM_INVOICES; i++) {
			invoices.add(invoiceCase(randomLines(random)));
		}

		List<Object> debits = new ArrayList<>();
		for (List<String[]> inputs : debitFixtures()) {
			debits.add(debitCase(inputs));
		}
		for (int i = 0; i < RANDOM_DEBITS; i++) {
			int count = 1 + random.nextInt(4);
			List<String[]> inputs = new ArrayList<>();
			for (int j = 0; j < count; j++) {
				String[] rate = RATES[random.nextInt(RATES.length)];
				inputs.add(new String[] { "Motivo " + (j + 1), positive(random, 1 + random.nextInt(5), random.nextInt(7)),
						rate[0], rate[1] });
			}
			debits.add(debitCase(inputs));
		}

		List<Object> prorations = new ArrayList<>();
		String[][] fixed = { { "1.00", "3", "1" }, { "0.00", "3", "1" }, { "10.00", "4", "4" }, { "5.00", "2", "1" },
				{ "0.01", "3", "2" }, { "7.77", "1.5", "0.5" }, { "100.00", "0.000001", "0.000001" },
				{ "0.50", "3", "1" }, { "1.005", "1", "1" } };
		for (String[] f : fixed) {
			prorations.add(prorationCase(f[0], f[1], f[2]));
		}
		for (int i = 0; i < RANDOM_PRORATIONS; i++) {
			BigDecimal originalQuantity = new BigDecimal(positive(random, 1 + random.nextInt(4), random.nextInt(7)));
			BigDecimal quantity = originalQuantity.multiply(BigDecimal.valueOf(1 + random.nextInt(100)))
				.divide(BigDecimal.valueOf(100), 6, RoundingMode.DOWN);
			if (quantity.signum() == 0) {
				quantity = originalQuantity;
			}
			prorations.add(prorationCase(decimal(random, 1 + random.nextInt(4), 2), originalQuantity.toString(),
					quantity.toString()));
		}

		Map<String, Object> root = new LinkedHashMap<>();
		root.put("invoices", invoices);
		root.put("debitNotes", debits);
		root.put("proratedDiscounts", prorations);
		return root;
	}

	/** Cada línea: cantidad, precio, descuento, código de tarifa y porcentaje. Los de TaxRoundingTest primero. */
	private static List<List<String[]>> invoiceFixtures() {
		List<List<String[]>> cases = new ArrayList<>();
		cases.add(rows(line("2", "10.00", "0", "4", "15")));
		cases.add(rows(line("1", "0.03", "0", "4", "15"), line("1", "0.03", "0", "4", "15"),
				line("1", "0.03", "0", "4", "15")));
		cases.add(rows(line("1", "0.10", "0", "4", "15"), line("1", "0.10", "0", "4", "15"),
				line("1", "0.10", "0", "4", "15")));
		cases.add(rows(line("1", "0.005", "0", "0", "0")));
		cases.add(rows(line("1", "0.004999", "0", "0", "0")));
		cases.add(rows(line("1.234567", "9.876543", "0", "2", "12")));
		cases.add(rows(line("3", "10.00", "5.00", "4", "15")));
		cases.add(rows(line("1", "10.00", "10.00", "4", "15")));
		cases.add(rows(line("1", "100.00", "0", "4", "15"), line("1", "50.00", "0", "0", "0"),
				line("2", "10.00", "0", "4", "15"), line("1", "20.00", "0", "10", "13")));
		cases.add(rows(line("1", "10.00", "0", "0", "0"), line("1", "10.00", "0", "6", "0"),
				line("1", "10.00", "0", "7", "0")));
		cases.add(rows(line("1.5", "3.333333", "0.1", "4", "15"), line("7", "0.1", "0", "5", "5")));
		cases.add(rows(line("999999999999.999999", "999999999999.999999", "0", "4", "15.00")));
		cases.add(rows(line("0.000001", "0.000001", "0", "4", "15.00")));
		// Rechazadas, en el orden de las comprobaciones de Java.
		cases.add(rows());
		cases.add(rows(line("0", "10.00", "0", "4", "15")));
		cases.add(rows(line("-1", "10.00", "0", "4", "15")));
		cases.add(rows(line("1", "-0.01", "0", "4", "15")));
		cases.add(rows(line("1", "10.00", "-0.01", "4", "15")));
		cases.add(rows(line("1", "10.00", "10.01", "4", "15")));
		cases.add(rows(line("1", "10.00", "0", "4", "-1")));
		cases.add(rows(line("0", "-1", "-1", "4", "-1")));
		cases.add(rows(line("1", "10.00", "0", "4", "15"), line("0", "10.00", "0", "4", "15")));
		return cases;
	}

	private static List<List<String[]>> debitFixtures() {
		List<List<String[]>> cases = new ArrayList<>();
		cases.add(rows(reason("Intereses de mora", "10.00", "4", "15"),
				reason("Gastos de cobranza", "5.00", "4", "15"), reason("Servicio exento", "3.00", "0", "0")));
		cases.add(rows(reason("a", "0.33", "4", "15"), reason("b", "0.33", "4", "15"),
				reason("c", "0.33", "4", "15")));
		cases.add(rows(reason("a", "0.30", "4", "15"), reason("b", "0.30", "4", "15"),
				reason("c", "0.30", "4", "15")));
		cases.add(rows(reason("a", "0.005", "4", "15")));
		cases.add(rows(reason("a", "0.004", "4", "15")));
		cases.add(rows(reason("a", "100", "10", "13.00"), reason("b", "50.555", "2", "12.00")));
		cases.add(rows(reason("a", "0.00", "4", "15")));
		cases.add(rows(reason("a", "-1.00", "4", "15")));
		cases.add(rows());
		cases.add(rows(reason("a", "1.00", "4", "-1")));
		cases.add(rows(reason("a", "0", "4", "-1")));
		return cases;
	}

	private static List<String[]> rows(String[]... rows) {
		return List.of(rows);
	}

	private static String[] line(String quantity, String unitPrice, String discount, String rateCode, String rate) {
		return new String[] { quantity, unitPrice, discount, rateCode, rate };
	}

	private static String[] reason(String reason, String value, String rateCode, String rate) {
		return new String[] { reason, value, rateCode, rate };
	}

	private static List<String[]> randomLines(Random random) {
		int count = 1 + random.nextInt(5);
		List<String[]> lines = new ArrayList<>();
		for (int i = 0; i < count; i++) {
			BigDecimal quantity = new BigDecimal(positive(random, 1 + random.nextInt(4), random.nextInt(7)));
			BigDecimal unitPrice = new BigDecimal(decimal(random, random.nextInt(5), random.nextInt(7)));
			BigDecimal gross = quantity.multiply(unitPrice);
			BigDecimal discount = switch (random.nextInt(4)) {
				case 0 -> BigDecimal.ZERO;
				case 1 -> gross.setScale(6, RoundingMode.DOWN);
				default -> gross.multiply(BigDecimal.valueOf(random.nextInt(101)))
					.divide(BigDecimal.valueOf(100), random.nextInt(7), RoundingMode.DOWN);
			};
			if (discount.compareTo(gross) > 0) {
				discount = BigDecimal.ZERO;
			}
			String[] rate = RATES[random.nextInt(RATES.length)];
			lines.add(line(quantity.toString(), unitPrice.toString(), discount.toString(), rate[0], rate[1]));
		}
		return lines;
	}

	/** Decimal de {@code integerDigits} enteros (0 da "0") y exactamente {@code scale} decimales. */
	private static String decimal(Random random, int integerDigits, int scale) {
		StringBuilder text = new StringBuilder();
		if (integerDigits == 0) {
			text.append('0');
		}
		for (int i = 0; i < integerDigits; i++) {
			text.append(i == 0 && integerDigits > 1 ? 1 + random.nextInt(9) : random.nextInt(10));
		}
		if (scale > 0) {
			text.append('.');
			for (int i = 0; i < scale; i++) {
				text.append(random.nextInt(10));
			}
		}
		return text.toString();
	}

	/** Como {@link #decimal} pero nunca cero. */
	private static String positive(Random random, int integerDigits, int scale) {
		String text = decimal(random, integerDigits, scale);
		return new BigDecimal(text).signum() == 0 ? "1" + (scale > 0 ? "." + "0".repeat(scale) : "") : text;
	}

	private static Map<String, Object> invoiceCase(List<String[]> lines) {
		List<InvoiceLineInput> inputs = new ArrayList<>();
		List<Object> json = new ArrayList<>();
		for (String[] l : lines) {
			inputs.add(new InvoiceLineInput(new BigDecimal(l[0]), new BigDecimal(l[1]), new BigDecimal(l[2]), l[3],
					new BigDecimal(l[4])));
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("quantity", l[0]);
			entry.put("unitPrice", l[1]);
			entry.put("discount", l[2]);
			entry.put("ivaRateCode", l[3]);
			entry.put("ivaRate", l[4]);
			json.add(entry);
		}
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("lines", json);
		try {
			InvoiceTotals totals = InvoiceCalculator.calculate(inputs);
			Map<String, Object> expected = new LinkedHashMap<>();
			List<Object> amounts = new ArrayList<>();
			for (LineAmounts a : totals.lines()) {
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("subtotal", a.subtotal().toString());
				m.put("taxAmount", a.taxAmount().toString());
				amounts.add(m);
			}
			expected.put("lines", amounts);
			expected.put("subtotal", totals.subtotal().toString());
			expected.put("totalDiscount", totals.totalDiscount().toString());
			List<Object> taxes = new ArrayList<>();
			for (TaxTotal t : totals.taxes()) {
				taxes.add(tax(t.taxCode(), t.rateCode(), t.rate(), t.base(), t.amount()));
			}
			expected.put("taxes", taxes);
			expected.put("totalTax", totals.totalTax().toString());
			expected.put("total", totals.total().toString());
			result.put("expected", expected);
		}
		catch (IllegalArgumentException e) {
			result.put("error", e.getMessage());
		}
		return result;
	}

	private static Map<String, Object> debitCase(List<String[]> inputs) {
		List<DebitNoteCalculator.Input> calcInputs = new ArrayList<>();
		List<Object> json = new ArrayList<>();
		for (String[] r : inputs) {
			calcInputs.add(new DebitNoteCalculator.Input(r[0], new BigDecimal(r[1]), r[2], new BigDecimal(r[3])));
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("reason", r[0]);
			entry.put("value", r[1]);
			entry.put("ivaRateCode", r[2]);
			entry.put("ivaRate", r[3]);
			json.add(entry);
		}
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("inputs", json);
		try {
			DebitNoteCalculator.Result calculated = DebitNoteCalculator.calculate(calcInputs);
			Map<String, Object> expected = new LinkedHashMap<>();
			List<Object> reasons = new ArrayList<>();
			for (var r : calculated.reasons()) {
				Map<String, Object> m = new LinkedHashMap<>();
				m.put("reason", r.reason());
				m.put("value", r.value().toString());
				m.put("taxCode", r.taxCode());
				m.put("taxRateCode", r.taxRateCode());
				m.put("taxRate", r.taxRate().toString());
				m.put("taxAmount", r.taxAmount().toString());
				reasons.add(m);
			}
			expected.put("reasons", reasons);
			List<Object> taxes = new ArrayList<>();
			for (NoteTax t : calculated.taxes()) {
				taxes.add(tax(t.taxCode(), t.rateCode(), t.rate(), t.base(), t.amount()));
			}
			expected.put("taxes", taxes);
			expected.put("subtotal", calculated.subtotal().toString());
			expected.put("totalTax", calculated.totalTax().toString());
			expected.put("total", calculated.total().toString());
			result.put("expected", expected);
		}
		catch (IllegalArgumentException e) {
			result.put("error", e.getMessage());
		}
		return result;
	}

	private static Map<String, Object> tax(String taxCode, String rateCode, BigDecimal rate, BigDecimal base,
			BigDecimal amount) {
		Map<String, Object> m = new LinkedHashMap<>();
		m.put("taxCode", taxCode);
		m.put("rateCode", rateCode);
		m.put("rate", rate.toString());
		m.put("base", base.toString());
		m.put("amount", amount.toString());
		return m;
	}

	private static Map<String, Object> prorationCase(String originalDiscount, String originalQuantity,
			String quantity) throws ReflectiveOperationException {
		LineRow original = new LineRow(1, "P", "d", new BigDecimal(originalQuantity), BigDecimal.ONE,
				new BigDecimal(originalDiscount), BigDecimal.ZERO, "2", "4", new BigDecimal("15.00"), BigDecimal.ZERO,
				null);
		Method method = CreditNoteService.class.getDeclaredMethod("proratedDiscount", LineRow.class, BigDecimal.class);
		method.setAccessible(true);
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("originalDiscount", originalDiscount);
		result.put("originalQuantity", originalQuantity);
		result.put("quantity", quantity);
		try {
			result.put("expected", method.invoke(null, original, new BigDecimal(quantity)).toString());
		}
		catch (InvocationTargetException e) {
			result.put("error", e.getCause().getMessage());
		}
		return result;
	}

}
