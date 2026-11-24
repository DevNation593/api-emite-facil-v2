package golden;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.example.einvoice.sri.AuthorizationResult;
import com.example.einvoice.sri.ReceptionResult;
import com.example.einvoice.sri.SriMessage;
import com.example.einvoice.sri.SriResponseParser;
import com.example.einvoice.support.SriSoapSamples;
import com.example.einvoice.support.SriSoapSamples.Msg;

/**
 * Peticiones SOAP de {@code SriSoapRequests} (privada del paquete: se invoca por reflexión) y el resultado de
 * {@code SriResponseParser} para las muestras de {@code SriSoapSamples} y para respuestas de borde. Cada cuerpo se
 * lee con los dos lectores (recepción y autorización). Los cuerpos y las peticiones van en Base64; las fechas, con
 * {@code OffsetDateTime.toString()}. Necesita {@code xades/} ya generado. Es determinista.
 */
final class SriCases {

	static final String KEY = "0503201201176001321000110010030009900641234567814";

	private SriCases() {
	}

	static Map<String, Object> generate(Path out) throws Exception {
		Map<String, Object> json = new LinkedHashMap<>();
		json.put("requests", requests(out));
		json.put("responses", responses());
		return json;
	}

	private static Map<String, Object> requests(Path out) throws Exception {
		Class<?> requests = Class.forName("com.example.einvoice.sri.SriSoapRequests");
		Method reception = requests.getDeclaredMethod("reception", byte[].class);
		Method authorization = requests.getDeclaredMethod("authorization", String.class);
		reception.setAccessible(true);
		authorization.setAccessible(true);

		Map<String, Object> result = new LinkedHashMap<>();
		List<Object> receptions = new ArrayList<>();
		for (String file : List.of("xades/factura-estandar/signed.xml", "xades/factura-caracteres-especiales/signed.xml",
				"xades/nota-credito-sobre-factura/signed.xml")) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("file", file);
			entry.put("request", base64((byte[]) reception.invoke(null, (Object) Files.readAllBytes(out.resolve(file)))));
			receptions.add(entry);
		}
		result.put("reception", receptions);

		List<Object> authorizations = new ArrayList<>();
		for (String key : new String[] { KEY, "1".repeat(49), "1".repeat(48),
				"1".repeat(50), "0503201201176001321000110010030009900641234567x14", "", null,
				"1</claveAccesoComprobante><x>", "٠".repeat(49) }) {
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("accessKey", key);
			try {
				entry.put("request", base64((byte[]) authorization.invoke(null, key)));
				entry.put("error", null);
			}
			catch (InvocationTargetException ex) {
				entry.put("request", null);
				entry.put("error", ex.getCause().getMessage());
			}
			authorizations.add(entry);
		}
		result.put("authorization", authorizations);
		return result;
	}

	private static List<Object> responses() {
		Map<String, String> bodies = new LinkedHashMap<>();
		bodies.put("recibida", SriSoapSamples.received());
		bodies.put("devuelta-dos-mensajes", SriSoapSamples.returned(KEY,
				new Msg("35", "DOCUMENTO INVÁLIDO", "Se encontró el siguiente error en la estructura", "ERROR"),
				Msg.error("45", "SECUENCIAL REGISTRADO")));
		bodies.put("devuelta-43", SriSoapSamples.returned(KEY, Msg.error("43", "CLAVE ACCESO REGISTRADA")));
		bodies.put("devuelta-sin-mensajes", SriSoapSamples.returned(KEY));
		bodies.put("recepcion-en-cola", SriSoapSamples.receptionWithState("EN COLA"));
		bodies.put("recepcion-minusculas", SriSoapSamples.receptionWithState(" recibida "));
		bodies.put("recepcion-sin-estado", SriSoapSamples.receptionWithState(""));
		bodies.put("autorizado", SriSoapSamples.authorized(KEY));
		bodies.put("autorizado-produccion-tilde", SriSoapSamples.authorizedIn(KEY, "PRODUCCIÓN"));
		bodies.put("autorizado-produccion-minusculas", SriSoapSamples.authorizedIn(KEY, "produccion"));
		bodies.put("rechazado", SriSoapSamples.notAuthorized(KEY, "RECHAZADO", Msg.error("46", "RUC no existe")));
		bodies.put("no-autorizado", SriSoapSamples.notAuthorized(KEY, "NO AUTORIZADO", Msg.error("46", "RUC no existe")));
		bodies.put("no-autorizado-minusculas", SriSoapSamples.notAuthorized(KEY, "no autorizado"));
		bodies.put("en-proceso", SriSoapSamples.processing(KEY));
		bodies.put("no-encontrado", SriSoapSamples.notFound(KEY));
		bodies.put("respuesta-de-autorizacion-vacia", SriSoapSamples.emptyAuthorizationResponse());
		bodies.put("fault", SriSoapSamples.fault());
		bodies.put("autorizado-gana", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T10:00:00-05:00", "PRUEBAS",
						Msg.error("39", "FIRMA INVALIDA")),
				SriSoapSamples.autorizacion("AUTORIZADO", KEY, "2012-03-05T12:00:00-05:00", "PRUEBAS"),
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T11:00:00-05:00", "PRUEBAS",
						Msg.error("52", "ERROR EN DIFERENCIAS"))));
		bodies.put("rechazo-mas-reciente", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T11:00:00-05:00", "PRUEBAS",
						Msg.error("52", "ERROR EN DIFERENCIAS")),
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T10:00:00-05:00", "PRUEBAS",
						Msg.error("39", "FIRMA INVALIDA"))));
		bodies.put("rechazos-sin-fecha", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, null, "PRUEBAS", Msg.error("52", "PRIMERO")),
				SriSoapSamples.autorizacion("RECHAZADO", null, "ayer", "PRUEBAS", Msg.error("39", "SEGUNDO"))));
		bodies.put("rechazo-con-y-sin-fecha", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, null, "PRUEBAS", Msg.error("52", "SIN FECHA")),
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T10:00:00Z", "PRUEBAS",
						Msg.error("39", "CON FECHA"))));
		bodies.put("misma-fecha", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T10:00:00-05:00", "PRUEBAS",
						Msg.error("52", "PRIMERO")),
				SriSoapSamples.autorizacion("NO AUTORIZADO", null, "2012-03-05T15:00:00Z", "PRUEBAS",
						Msg.error("39", "MISMO INSTANTE"))));
		bodies.put("autorizado-sin-numero", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", null, SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-fecha-ilegible", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", KEY, "ayer por la tarde", "PRUEBAS")));
		bodies.put("autorizado-numero-letras", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", "ABC", SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-numero-9", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", "123456789", SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-numero-10", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", "1234567890", SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-numero-50", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", "1".repeat(50), SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-numero-arabe", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", "١".repeat(12), SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-minusculas", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("autorizado", KEY, SriSoapSamples.AUTHORIZATION_DATE, "PRUEBAS")));
		bodies.put("autorizado-sin-ambiente", SriSoapSamples.authorizations(KEY,
				SriSoapSamples.autorizacion("AUTORIZADO", KEY, SriSoapSamples.AUTHORIZATION_DATE, null)));
		bodies.put("autorizado-otra-clave", SriSoapSamples.authorized("1".repeat(49)));
		for (String date : new String[] { "2026-10-11T09:30:00", "2026-10-11T09:30", "2026-10-11T09:30:00.5",
				"2026-10-11T09:30:00.123456", "2026-10-11T09:30:00.123456789", "2026-10-11T09:30:00.1234567891",
				"2026-10-11T09:30:00Z", "2026-10-11T09:30:00+00:00", "2026-10-11T09:30:00-0500", "2026-10-11T09:30:00-05",
				"2026-10-11T09:30:00-05:00:30", "2026-10-11T09:30:00.120-05:00", "2026-10-11T09:30:00.000-05:00",
				"2026-10-11T09:30:00+18:00", "2026-10-11T09:30:00+19:00", "2026-02-30T09:30:00-05:00",
				"2026-10-11T24:00:00-05:00", "2026-10-11T23:59:60-05:00", "2026-10-11 09:30:00", "11/10/2026 09:30:00",
				"2026-10-11", "+12026-10-11T09:30:00-05:00", "2026-10-11t09:30:00-05:00", "2026-10-11T09:30:00z" }) {
			bodies.put("fecha " + date, SriSoapSamples.authorizations(KEY,
					SriSoapSamples.autorizacion("AUTORIZADO", KEY, date, "PRUEBAS")));
		}
		bodies.put("html", "<html><body>503 Service Unavailable</body></html>");
		bodies.put("vacio", "");
		bodies.put("texto", "no es xml");
		bodies.put("doctype-con-entidad",
				"<!DOCTYPE x [<!ENTITY e SYSTEM \"file:///etc/passwd\">]>" + SriSoapSamples.received());
		bodies.put("sin-respuesta",
				"<soap:Envelope xmlns:soap=\"http://schemas.xmlsoap.org/soap/envelope/\"><soap:Body/></soap:Envelope>");
		bodies.put("dos-respuestas", SriSoapSamples.received().replace("</soap:Body>",
				"<RespuestaRecepcionComprobante><estado>DEVUELTA</estado></RespuestaRecepcionComprobante>"
						+ "<RespuestaAutorizacionComprobante/><RespuestaAutorizacionComprobante/></soap:Body>"));
		bodies.put("sin-envoltorio", "<RespuestaRecepcionComprobante><estado>RECIBIDA</estado></RespuestaRecepcionComprobante>");
		bodies.put("con-prefijo", "<a:RespuestaRecepcionComprobante xmlns:a=\"urn:x\"><a:estado>DEVUELTA</a:estado>"
				+ "<a:comprobantes><a:comprobante><a:mensajes><a:mensaje><a:identificador>35</a:identificador>"
				+ "<a:tipo>ERROR</a:tipo></a:mensaje></a:mensajes></a:comprobante></a:comprobantes>"
				+ "</a:RespuestaRecepcionComprobante>");
		bodies.put("con-bom", "﻿" + SriSoapSamples.received());
		bodies.put("entidades-y-cdata", SriSoapSamples.returned(KEY,
				new Msg("35", "A &amp; B &lt;c&gt; &#233; <![CDATA[<d>]]>", "   espacios  \t\n", "ERROR")));
		bodies.put("mensaje-vacio", SriSoapSamples.returned(KEY, new Msg("", "", null, "")));
		bodies.put("comentarios", SriSoapSamples.received().replace("RECIBIDA", "REC<!-- x -->IBIDA"));
		bodies.put("mal-formado", SriSoapSamples.received().replace("</soap:Envelope>", ""));
		bodies.put("fault-sin-prefijo", "<Envelope><Body><Fault/></Body></Envelope>");

		String longText = "x".repeat(5000);
		bodies.put("textos-largos", SriSoapSamples.returned(KEY, new Msg("1".repeat(25), longText, "y".repeat(5000),
				"T".repeat(40))).replace("<estado>DEVUELTA</estado>", "<estado>DEVUELTA" + "z".repeat(80) + "</estado>"));
		bodies.put("estado-largo", SriSoapSamples.receptionWithState("Ñ".repeat(80)));
		Msg[] many = new Msg[150];
		for (int i = 0; i < many.length; i++) {
			many[i] = new Msg(String.valueOf(i), "mensaje " + i, null, "ERROR");
		}
		bodies.put("150-mensajes", SriSoapSamples.returned(KEY, many));
		bodies.put("150-mensajes-autorizacion", SriSoapSamples.notAuthorized(KEY, "NO AUTORIZADO", many));
		bodies.put("mensajes-en-dos-comprobantes", SriSoapSamples.returned(KEY, Msg.error("35", "UNO")).replace(
				"</comprobantes>", "<comprobante><mensajes>" + "<mensaje><identificador>43</identificador>"
						+ "<mensaje>DOS</mensaje><tipo>ERROR</tipo></mensaje></mensajes></comprobante></comprobantes>"));
		bodies.put("emoji-en-limite", SriSoapSamples.returned(KEY,
				new Msg("35", "x".repeat(1999) + "😀", null, "ERROR")));

		List<Object> cases = new ArrayList<>();
		for (Map.Entry<String, String> body : bodies.entrySet()) {
			byte[] bytes = body.getValue().getBytes(StandardCharsets.UTF_8);
			Map<String, Object> entry = new LinkedHashMap<>();
			entry.put("name", body.getKey());
			entry.put("body", base64(bytes));
			entry.put("reception", reception(SriResponseParser.reception(bytes)));
			entry.put("authorization", authorization(SriResponseParser.authorization(bytes)));
			cases.add(entry);
		}
		return cases;
	}

	private static Map<String, Object> reception(ReceptionResult result) {
		Map<String, Object> json = new LinkedHashMap<>();
		json.put("outcome", result.outcome().name());
		json.put("sriStatus", result.sriStatus());
		json.put("messages", messages(result.messages()));
		json.put("httpStatus", result.httpStatus());
		json.put("errorDetail", result.errorDetail());
		json.put("rawResponse", result.rawResponse() == null ? null : base64(result.rawResponse()));
		return json;
	}

	private static Map<String, Object> authorization(AuthorizationResult result) {
		Map<String, Object> json = new LinkedHashMap<>();
		json.put("outcome", result.outcome().name());
		json.put("sriStatus", result.sriStatus());
		json.put("consultedAccessKey", result.consultedAccessKey());
		json.put("authorizationNumber", result.authorizationNumber());
		json.put("authorizedAt", result.authorizedAt() == null ? null : result.authorizedAt().toString());
		json.put("environmentLabel", result.environmentLabel());
		json.put("messages", messages(result.messages()));
		json.put("httpStatus", result.httpStatus());
		json.put("errorDetail", result.errorDetail());
		json.put("rawResponse", result.rawResponse() == null ? null : base64(result.rawResponse()));
		return json;
	}

	private static List<Object> messages(List<SriMessage> messages) {
		List<Object> list = new ArrayList<>();
		for (SriMessage message : messages) {
			Map<String, Object> json = new LinkedHashMap<>();
			json.put("identifier", message.identifier());
			json.put("message", message.message());
			json.put("additionalInfo", message.additionalInfo());
			json.put("type", message.type());
			list.add(json);
		}
		return list;
	}

	private static String base64(byte[] bytes) {
		return Base64.getEncoder().encodeToString(bytes);
	}

}
