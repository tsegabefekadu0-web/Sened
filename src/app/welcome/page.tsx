import { LandingPage } from "@/components/landing/LandingPage";

/** `/welcome` keeps working: the same public landing page that signed-out visitors see at `/`. */
export default function WelcomePage() {
  return <LandingPage />;
}
