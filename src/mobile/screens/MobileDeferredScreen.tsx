import { ArrowRight } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MobileAppBar } from "@/mobile/components/MobileAppBar";

export function MobileDeferredScreen({ title }: { title: string }) {
  const navigate = useNavigate();
  return (
    <section className="mobile-deferred-screen">
      <MobileAppBar title={title} leadingAction={<button type="button" className="mobile-icon-button" onClick={() => navigate(-1)} aria-label="رجوع"><ArrowRight aria-hidden="true" /></button>} />
      <div className="mobile-deferred-content">
        <p className="mobile-eyebrow">قريباً</p>
        <h1>{title}</h1>
        <p>هذه الشاشة ستصل في المرحلة التشغيلية التالية.</p>
      </div>
    </section>
  );
}