import Foundation

struct Goal: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var name: String
    var description: String?
    var color: String // '#4F46E5'
    var createdAt: Double // ms
}

struct TrueNorthGoal: Codable, Equatable, Sendable, Identifiable {
    var id: String
    var vision: String
    var isMoneyGoal: Bool
    var tangibleReality: String?
    var sensoryDetails: String
    var planB: String
    var importance: Int // 1-10
    var anchorHabit: String?
    var anchorTask: String?
    var createdAt: Double
}
