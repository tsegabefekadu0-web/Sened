import { HomeScreen } from "@/components/home/HomeScreen";

/** `/home`: the app Home, always. Signed-out visitors reach it as the labelled sample; members also get it at `/`. */
export default function HomeRoute() {
  return <HomeScreen />;
}
