import type { Problem } from "@/lib/types";
import { urlShortener } from "./design-url-shortener";
import { adClickAggregator } from "./ad-click-aggregator";
import { newsAggregator } from "./news-aggregator";
import { priceTrackingService } from "./price-tracking-service";
import { webCrawler } from "./web-crawler";
import { adExchangeRtb } from "./ad-exchange-rtb";
import { dropbox } from "./dropbox";
import { objectStorage } from "./object-storage";
import { youtubeTopK } from "./youtube-top-k";
import { rateLimiter } from "./rate-limiter";
import { distributedCache } from "./distributed-cache";
import { metricsMonitoring } from "./metrics-monitoring";
import { jobScheduler } from "./job-scheduler";
import { notificationSystem } from "./notification-system";
import { taggingSystem } from "./tagging-system";
import { github } from "./github";
import { leetcode } from "./leetcode";
import { multiTenantSaas } from "./multi-tenant-saas";
import { fbLiveComments } from "./fb-live-comments";
import { strava } from "./strava";
import { googleMaps } from "./google-maps";
import { localDelivery } from "./local-delivery";
import { uber } from "./uber";
import { fbPostSearch } from "./fb-post-search";
import { newsFeed } from "./news-feed";
import { searchAutocomplete } from "./search-autocomplete";
import { tinder } from "./tinder";
import { yelp } from "./yelp";
import { ecommerceFlashSales } from "./ecommerce-flash-sales";
import { instagram } from "./instagram";
import { onlineAuction } from "./online-auction";
import { paymentSystem } from "./payment-system";
import { robinhood } from "./robinhood";
import { shazam } from "./shazam";
import { ticketmaster } from "./ticketmaster";
import { youtube } from "./youtube";
import { chatE2ee } from "./chat-e2ee";
import { aiAgentRestaurant } from "./ai-agent-restaurant";
import { aiSoftwareEngineer } from "./ai-software-engineer";
import { chatgpt } from "./chatgpt";
import { googleDocs } from "./google-docs";
import { ragPlatform } from "./rag-platform";
import { vectorDatabase } from "./vector-database";
import { llmInferenceServing } from "./llm-inference-serving";
import { distributedTraining70b } from "./distributed-training-70b";
import { llmEvaluation } from "./llm-evaluation";
import { llmSafetyModeration } from "./llm-safety-moderation";
import { aiModelRollout } from "./ai-model-rollout";

// Auto-generated registry. Adding a design = drop in data/problems/<slug>.ts
// exporting a `Problem`, then re-run scripts/gen-index.
export const problems: Record<string, Problem> = {
  [urlShortener.slug]: urlShortener,
  [adClickAggregator.slug]: adClickAggregator,
  [newsAggregator.slug]: newsAggregator,
  [priceTrackingService.slug]: priceTrackingService,
  [webCrawler.slug]: webCrawler,
  [adExchangeRtb.slug]: adExchangeRtb,
  [dropbox.slug]: dropbox,
  [objectStorage.slug]: objectStorage,
  [youtubeTopK.slug]: youtubeTopK,
  [rateLimiter.slug]: rateLimiter,
  [distributedCache.slug]: distributedCache,
  [metricsMonitoring.slug]: metricsMonitoring,
  [jobScheduler.slug]: jobScheduler,
  [notificationSystem.slug]: notificationSystem,
  [taggingSystem.slug]: taggingSystem,
  [github.slug]: github,
  [leetcode.slug]: leetcode,
  [multiTenantSaas.slug]: multiTenantSaas,
  [fbLiveComments.slug]: fbLiveComments,
  [strava.slug]: strava,
  [googleMaps.slug]: googleMaps,
  [localDelivery.slug]: localDelivery,
  [uber.slug]: uber,
  [fbPostSearch.slug]: fbPostSearch,
  [newsFeed.slug]: newsFeed,
  [searchAutocomplete.slug]: searchAutocomplete,
  [tinder.slug]: tinder,
  [yelp.slug]: yelp,
  [ecommerceFlashSales.slug]: ecommerceFlashSales,
  [instagram.slug]: instagram,
  [onlineAuction.slug]: onlineAuction,
  [paymentSystem.slug]: paymentSystem,
  [robinhood.slug]: robinhood,
  [shazam.slug]: shazam,
  [ticketmaster.slug]: ticketmaster,
  [youtube.slug]: youtube,
  [chatE2ee.slug]: chatE2ee,
  [aiAgentRestaurant.slug]: aiAgentRestaurant,
  [aiSoftwareEngineer.slug]: aiSoftwareEngineer,
  [chatgpt.slug]: chatgpt,
  [googleDocs.slug]: googleDocs,
  [ragPlatform.slug]: ragPlatform,
  [vectorDatabase.slug]: vectorDatabase,
  [llmInferenceServing.slug]: llmInferenceServing,
  [distributedTraining70b.slug]: distributedTraining70b,
  [llmEvaluation.slug]: llmEvaluation,
  [llmSafetyModeration.slug]: llmSafetyModeration,
  [aiModelRollout.slug]: aiModelRollout,
};

export function getProblem(slug: string): Problem | null {
  return problems[slug] ?? null;
}
