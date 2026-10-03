import { MessageCircle } from "lucide-react";
import { whatsAppTarget, whatsAppUrl } from "@/lib/whatsapp";

/**
 * «واتساب»: opens WhatsApp with `message` prefilled. The user presses Send.
 *
 * Never a dead button: no number says so, and a number WhatsApp cannot open
 * says where to fix it instead of opening a chat with the wrong person.
 */
export function WhatsAppAction({
  phone,
  message,
  fixWhere,
  label = "واتساب",
}: {
  phone: string | null | undefined;
  message: string;
  /** Where the stored number can be corrected, e.g. «من شاشة العملاء على الكمبيوتر». */
  fixWhere: string;
  label?: string;
}) {
  const target = whatsAppTarget(phone);
  if (target.status === "missing") {
    return <p className="mobile-whatsapp-note">رقم واتساب غير مسجل</p>;
  }
  if (target.status === "invalid") {
    return (
      <p className="mobile-whatsapp-note is-warning" role="status">
        رقم الموبايل المسجل مش صالح لواتساب — صحّحه {fixWhere}.
      </p>
    );
  }
  return (
    <a
      className="mobile-secondary-button mobile-whatsapp-button"
      href={whatsAppUrl(target.number, message)}
      target="_blank"
      rel="noopener noreferrer"
    >
      <MessageCircle aria-hidden="true" />
      {label}
    </a>
  );
}

/**
 * The compact form: a WhatsApp icon beside a phone number, for lists and
 * detail headers. Same number rules as `WhatsAppAction` (`whatsAppTarget`):
 * no number, or one WhatsApp cannot open, renders NOTHING — never a dead or
 * wrong link. The full button on the customer's own page is where an invalid
 * number is explained.
 *
 * A plain external link. It reads nothing and writes nothing, so it grants no
 * role anything; it stops propagation so a row it sits beside never also
 * navigates.
 */
export function WhatsAppIconLink({
  phone,
  message,
  label = "فتح واتساب",
}: {
  phone: string | null | undefined;
  message: string;
  label?: string;
}) {
  const target = whatsAppTarget(phone);
  if (target.status !== "ok") return null;
  return (
    <a
      className="mobile-whatsapp-icon"
      href={whatsAppUrl(target.number, message)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      onClick={(event) => event.stopPropagation()}
    >
      <MessageCircle aria-hidden="true" />
    </a>
  );
}
